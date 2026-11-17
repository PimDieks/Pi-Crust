#!/usr/bin/env node
// Secret check: stops commits and pushes that would put credentials in the repo.
// Run by the git hooks in .githooks (pre-commit: staged changes; pre-push: every commit being pushed), and by hand:
//   node scripts/check-secrets.js --staged          what `git commit` would add
//   node scripts/check-secrets.js --push            reads git's pre-push lines from stdin
//   node scripts/check-secrets.js --range A..B      commits in a range
//   node scripts/check-secrets.js --all             every tracked file as it is now
//   node scripts/check-secrets.js --history         every commit on every branch (added lines, messages, author names and emails)
// Options (any position):
//   --denylist FILE      words or regexes that must never appear (one per line, case-insensitive, # for comments).
//                        Default: .leak-denylist in the repo root (gitignored, never committed). Hits print file, line and
//                        rule number only, never the word. Binary files are skipped and counted.
//   --require-denylist   exit 1 when there is no deny-list (use in CI). Without it a missing default list is silent (--verbose mentions it).
//   --verbose            also say when no deny-list was found.
//   --root DIR           scan the repo at DIR instead of the current one.
// It looks at added lines only and at file names. A line that is a known false positive can carry the comment
// `secret-check: allow`. Exit code 1 when something is found.
"use strict";

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

// --- Deny-list (words that must stay out of this repo; the list itself is a local, untracked file) -----------------

let ROOT = null; // set by --root
let DENY = []; // [{ n, re }]
const skipped = { binary: 0, scanned: 0 };
let verbose = false;

function loadDenyList(file) {
	const rules = [];
	fs.readFileSync(file, "utf8").split(/\r?\n/).forEach((raw) => {
		const t = raw.trim();
		if (!t || t.startsWith("#")) return;
		rules.push({ n: rules.length + 1, re: new RegExp(t, "i") });
	});
	return rules;
}
function denyHits(text) {
	return DENY.filter((r) => r.re.test(text)).map((r) => ({ why: `deny-list rule #${r.n}`, sample: "(hidden)" }));
}

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
	const found = denyHits(line); // the deny-list ignores `secret-check: allow`
	if (ALLOW_COMMENT.test(line)) return found;
	const inTest = isTestFile(file);
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
	const d = denyHits(f);
	if (d.length) return `${d[0].why} (file name)`;
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

const git = (args, input) => execFileSync("git", ROOT ? ["-C", ROOT, ...args] : args, { encoding: "utf8", maxBuffer: 512e6, input, stdio: ["pipe", "pipe", "pipe"] });
const ZERO = /^0+$/;
const DIFF = ["--no-color", "--no-ext-diff", "-U0", "--find-renames"];

// Binary files show up in a diff as "Binary files ... differ" (no added lines) and are not scanned. Count them.
function countBinary(diff) {
	skipped.binary += diff.split(/\r?\n/).filter((l) => /^Binary files .* differ$/.test(l) || l === "GIT binary patch").length;
}
function scanStaged() {
	const diff = git(["diff", "--cached", ...DIFF, "--diff-filter=ACMR"]);
	countBinary(diff);
	return scanDiff(diff, "staged");
}
function scanCommits(shas) {
	const findings = [];
	for (const sha of shas) {
		const out = git(["show", ...DIFF, "--diff-filter=ACMR", "--format=", "-m", "--first-parent", sha]);
		countBinary(out);
		findings.push(...scanDiff(out, sha.slice(0, 8)));
		if (DENY.length) {
			const meta = git(["show", "--no-patch", "--format=%an <%ae>%n%cn <%ce>%n%B", sha]).split("\n");
			meta.forEach((l, i) => {
				for (const f of denyHits(l)) findings.push({ file: i < 2 ? "(author/committer)" : "(commit message)", line: i < 2 ? 0 : i - 1, ...f, where: sha.slice(0, 8) });
			});
		}
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
	const eol = git(["ls-files", "--eol"]).split("\n").filter(Boolean);
	skipped.binary = eol.filter((l) => /^i\/-text/.test(l)).length;
	skipped.scanned = files.length - skipped.binary;
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
	for (const row of grep.split(/\r?\n/)) {
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

const summary = () => {
	const parts = [];
	if (skipped.scanned) parts.push(`scanned ${skipped.scanned} text files`);
	parts.push(`skipped ${skipped.binary} binary file${skipped.binary === 1 ? "" : "s"}`);
	if (DENY.length) parts.push(`${DENY.length} deny-list rules`);
	process.stderr.write(parts.join(", ").replace(/^./, (c) => c.toUpperCase()) + ".\n");
};

function main(args) {
	const argv = [];
	let denyFile = null;
	let requireDeny = false;
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--denylist") denyFile = args[++i];
		else if (args[i] === "--root") ROOT = path.resolve(args[++i]);
		else if (args[i] === "--require-denylist") requireDeny = true;
		else if (args[i] === "--verbose") verbose = true;
		else argv.push(args[i]);
	}
	if (!denyFile) {
		const top = ROOT || git(["rev-parse", "--show-toplevel"]).trim();
		const def = path.join(top, ".leak-denylist");
		if (fs.existsSync(def)) denyFile = def;
	}
	if (denyFile && !fs.existsSync(denyFile)) {
		process.stderr.write(`Deny-list file not found: ${denyFile}\n`);
		return 1;
	}
	if (denyFile) DENY = loadDenyList(denyFile);
	else {
		if (requireDeny || verbose) process.stderr.write("no deny-list found, scan not run\n");
		if (requireDeny) return 1;
		// A release scan must not give false assurance: say so in the full-scan modes, stay silent for the hooks.
		if (!verbose && (argv[0] === "--all" || argv[0] === "--history")) process.stderr.write("note: no deny-list found, so only the built-in patterns were checked\n");
	}
	const mode = argv[0] || "--staged";
	if (mode === "--staged") {
		const code = report(scanStaged(), "the staged changes");
		if (skipped.binary) summary();
		return code;
	}
	if (mode === "--push") {
		const stdin = require("node:fs").readFileSync(0, "utf8");
		const code = report(scanPush(stdin), "this push");
		if (skipped.binary) summary();
		return code;
	}
	if (mode === "--range") {
		const code = report(scanCommits(commitsInRange([argv[1]])), argv[1]);
		if (skipped.binary) summary();
		return code;
	}
	if (mode === "--all") {
		const code = report(scanAll(), "the tracked files");
		process.stderr.write(`Scanned ${skipped.scanned} text files, skipped ${skipped.binary} binary files${DENY.length ? `, ${DENY.length} deny-list rules` : ""}.\n`);
		return code;
	}
	if (mode === "--history") {
		const code = report(scanCommits(commitsInRange(["--all"])), "the history");
		if (skipped.binary) summary();
		return code;
	}
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

module.exports = { loadDenyList, scanLine, scanFileName, scanDiff, isTestFile };
