#!/usr/bin/env node
// Secret check: stops commits and pushes that would put credentials in the repo.
// Run by the git hooks in .githooks (pre-commit: staged changes; pre-push: every commit being pushed), and by hand:
//   node scripts/check-secrets.js --staged          what `git commit` would add
//   node scripts/check-secrets.js --push            reads git's pre-push lines from stdin
//   node scripts/check-secrets.js --range A..B      commits in a range
//   node scripts/check-secrets.js --all             every tracked file as it is now
//   node scripts/check-secrets.js --history         every commit on every branch
// It looks at added lines only and at file names. A line that is a known false positive can carry the comment
// `secret-check: allow`. Exit code 1 when something is found.
"use strict";

const { execFileSync } = require("node:child_process");
const path = require("node:path");

// --- Rules ------------------------------------------------------------------------------------------------------

// Files that should never be committed, by name.
const FORBIDDEN_FILES = [
	{ re: /(^|\/)\.env(\.[^/]+)?$/i, why: ".env file", allow: /\.env\.(example|sample|template|dist)$/i },
	{ re: /(^|\/)(auth|mcp-auth|credentials|service-account[^/]*)\.json$/i, why: "credentials file" },
	{ re: /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i, why: "SSH key" },
	{ re: /\.(pem|key|p12|pfx|jks|keystore|ppk|mobileprovision)$/i, why: "key or certificate file" },
	{ re: /(^|\/)\.(npmrc|netrc|pypirc|htpasswd|git-credentials|figma-token)$/i, why: "file that usually holds a token or password" },
	{ re: /(^|\/)\.pi\/agent\/(auth|models-store)\.json$/i, why: "Pi login file" },
];

// Secret formats in added lines.
const PATTERNS = [
	{ re: /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY(?: BLOCK)?-----/, why: "private key" },
	{ re: /\bsk-ant-(?:api|oat|admin)\d{2}-[A-Za-z0-9_-]{20,}/, why: "Anthropic key or token" },
	{ re: /\bsk-(?!ant-)(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/, why: "OpenAI-style secret key" },
	{ re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/, why: "GitHub token" },
	{ re: /\bgithub_pat_[A-Za-z0-9_]{50,}\b/, why: "GitHub fine-grained token" },
	{ re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, why: "AWS access key id" },
	{ re: /\bAIza[0-9A-Za-z_-]{35}\b/, why: "Google API key" },
	{ re: /\bya29\.[0-9A-Za-z_-]{20,}/, why: "Google OAuth token" },
	{ re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/, why: "Slack token" },
	{ re: /\bhttps:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]{20,}/, why: "Slack webhook" },
	{ re: /\b[rs]k_live_[0-9a-zA-Z]{20,}\b/, why: "Stripe live key" },
	{ re: /\bfigd_[A-Za-z0-9_-]{20,}/, why: "Figma token" },
	{ re: /\bnpm_[A-Za-z0-9]{36}\b/, why: "npm token" },
	{ re: /\btskey-[a-z]+-[A-Za-z0-9-]{10,}/, why: "Tailscale auth key" },
	{ re: /\bglpat-[A-Za-z0-9_-]{20,}/, why: "GitLab token" },
	{ re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, why: "JWT (signed token)" },
	{ re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@"'`]+:([^\s/:@"'`$]{6,})@[^\s/]+/i, why: "password in a URL", value: 1, generic: true },
	{
		re: /\b(?:api[_-]?key|api[_-]?secret|secret[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|auth[_-]?token|private[_-]?key|password|passwd|pwd)["']?\s*[:=]\s*["'`]([^"'`\s]{12,})["'`]/i,
		why: "hard-coded secret",
		value: 1,
		generic: true,
	},
];

// Values that are clearly not real secrets (placeholders, variables, examples).
const PLACEHOLDER = /\$\{|\$\(|<[^>]*>|\{\{|example|sample|dummy|placeholder|changeme|your[_-]?|xxxx|\*\*\*\*|redacted|fake|process\.env|^[a-z_.]+$/i;
const ALLOW_COMMENT = /secret-check:\s*allow/i;
// Test files (foo.test.js, foo.spec.ts, __tests__/, test/ or tests/ folders) are full of made-up passwords in URLs
// and assignments, so the generic patterns are skipped there. Real token formats (keys with a known prefix) still count.
const TEST_FILE = /(^|\/)(__tests__|tests?)\/|\.(test|spec)\.[cm]?[jt]sx?$/i;
const isTestFile = (file) => TEST_FILE.test(String(file || "").split(path.sep).join("/"));

function mask(s) {
	if (s.length <= 8) return "****";
	return `${s.slice(0, 4)}…${s.slice(-2)} (${s.length} chars)`;
}

// One added line (of `file`, when known) -> findings.
function scanLine(line, file = "") {
	if (ALLOW_COMMENT.test(line)) return [];
	const inTest = isTestFile(file);
	const found = [];
	for (const p of PATTERNS) {
		if (p.generic && inTest) continue;
		const m = p.re.exec(line);
		if (!m) continue;
		const value = p.value ? m[p.value] : m[0];
		if (p.value) {
			if (PLACEHOLDER.test(value)) continue;
			// Generic assignments: only values that look random (letters and digits mixed).
			if (p.why === "hard-coded secret" && !(/[A-Za-z]/.test(value) && /\d/.test(value))) continue;
		}
		found.push({ why: p.why, sample: mask(value) });
	}
	return found;
}

function scanFileName(file) {
	const f = file.split(path.sep).join("/");
	for (const r of FORBIDDEN_FILES) if (r.re.test(f) && !(r.allow && r.allow.test(f))) return r.why;
	return null;
}

// A unified diff (git diff / git show, -U0) -> findings with file and line.
function scanDiff(diff, where = "") {
	const findings = [];
	let file = null;
	let lineNo = 0;
	for (const raw of diff.split("\n")) {
		if (raw.startsWith("+++ ")) {
			file = raw === "+++ /dev/null" ? null : raw.slice(4).replace(/^b\//, "");
			if (file) {
				const why = scanFileName(file);
				if (why) findings.push({ file, line: 0, why, sample: "file name", where });
			}
			continue;
		}
		if (raw.startsWith("@@")) {
			const m = /\+(\d+)/.exec(raw);
			lineNo = m ? Number(m[1]) : 0;
			continue;
		}
		if (!file) continue;
		if (raw.startsWith("+")) {
			for (const f of scanLine(raw.slice(1), file)) findings.push({ file, line: lineNo, ...f, where });
			lineNo++;
		}
	}
	return findings;
}

// --- git ------------------------------------------------------------------------------------------------------

const git = (args, input) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 512e6, input, stdio: ["pipe", "pipe", "pipe"] });
const ZERO = /^0+$/;
const DIFF = ["--no-color", "--no-ext-diff", "-U0", "--find-renames"];

function scanStaged() {
	return scanDiff(git(["diff", "--cached", ...DIFF, "--diff-filter=ACMR"]), "staged");
}
function scanCommits(shas) {
	const findings = [];
	for (const sha of shas) {
		const out = git(["show", ...DIFF, "--diff-filter=ACMR", "--format=", "-m", "--first-parent", sha]);
		findings.push(...scanDiff(out, sha.slice(0, 8)));
	}
	return findings;
}
function commitsInRange(range) {
	const out = git(["rev-list", "--no-merges", ...range]).trim();
	return out ? out.split("\n") : [];
}
// pre-push stdin: "<local ref> <local sha> <remote ref> <remote sha>" per ref being pushed.
function scanPush(stdin) {
	const shas = new Set();
	for (const line of stdin.split("\n")) {
		const [, local, , remote] = line.trim().split(/\s+/);
		if (!local || ZERO.test(local)) continue; // deleting a branch
		const range = remote && !ZERO.test(remote) ? [`${remote}..${local}`] : [local, "--not", "--remotes"];
		for (const sha of commitsInRange(range)) shas.add(sha);
	}
	return scanCommits([...shas]);
}
function scanAll() {
	const findings = [];
	const files = git(["ls-files", "-z"]).split("\0").filter(Boolean);
	for (const file of files) {
		const why = scanFileName(file);
		if (why) findings.push({ file, line: 0, why, sample: "file name", where: "tracked" });
	}
	const grep = (() => {
		try {
			return git(["grep", "-n", "-I", "--no-color", "-E", "-e", "."]);
		} catch {
			return "";
		}
	})();
	for (const row of grep.split("\n")) {
		const m = /^(.*?):(\d+):(.*)$/.exec(row);
		if (!m) continue;
		for (const f of scanLine(m[3], m[1])) findings.push({ file: m[1], line: Number(m[2]), ...f, where: "tracked" });
	}
	return findings;
}

function report(findings, context) {
	if (!findings.length) return 0;
	const out = [`\n✋ Secret check: ${findings.length} possible secret(s) in ${context}. Nothing was ${context === "this push" ? "pushed" : "committed"}.\n`];
	for (const f of findings) out.push(`  ${f.file}${f.line ? `:${f.line}` : ""}  ${f.why}  [${f.sample}]${f.where && f.where !== "staged" && f.where !== "tracked" ? `  (commit ${f.where})` : ""}`);
	out.push(
		"",
		"Remove the secret (use an environment variable or a file outside the repo instead).",
		"If it's already in a commit, rewrite that commit (git commit --amend, or git rebase -i) before pushing.",
		"A false positive: add the comment `secret-check: allow` on that line, or ask before using --no-verify.",
		"",
	);
	process.stderr.write(out.join("\n"));
	return 1;
}

function main(argv) {
	const mode = argv[0] || "--staged";
	if (mode === "--staged") return report(scanStaged(), "the staged changes");
	if (mode === "--push") {
		const stdin = require("node:fs").readFileSync(0, "utf8");
		return report(scanPush(stdin), "this push");
	}
	if (mode === "--range") return report(scanCommits(commitsInRange([argv[1]])), argv[1]);
	if (mode === "--all") return report(scanAll(), "the tracked files");
	if (mode === "--history") return report(scanCommits(commitsInRange(["--all"])), "the history");
	process.stderr.write(`Unknown option ${mode}. Use --staged, --push, --range A..B, --all or --history.\n`);
	return 2;
}

if (require.main === module) {
	try {
		process.exitCode = main(process.argv.slice(2));
	} catch (e) {
		process.stderr.write(`Secret check failed to run: ${e.message}\n`);
		process.exitCode = 1;
	}
}

module.exports = { scanLine, scanFileName, scanDiff, isTestFile };
