#!/usr/bin/env node
// Agent boundary check (phase 6, step S9). Everything that is specific to Pi lives behind the agent adapter: src/agents/pi/ and the
// extension files in src/pi-extension/. This script fails when Pi specifics show up anywhere else in src/, unless the place is in the
// allow-list file (scripts/agent-boundary-allow.json), where every entry names the rule, the file, the text of the reviewed line and a reason.
//
//   node scripts/check-agent-boundary.js [--root <repo>] [--allow <file>] [--list]
//
// Exit 0: no hit outside the adapter and the allow-list, and no allow-list entry that matches nothing (a stale entry is a failure too,
// so the list can only shrink unnoticed never). Exit 1: a hit, a stale or incomplete entry. Exit 2: bad usage.
// Comments are ignored (they may talk about Pi); strings and code are not.
//
// One more rule, "claude-code-name", is not about Pi: the product name "Claude Code" must not appear in anything a user sees. It is checked in
// every string and line of code in src/ (the adapter folders included; comments there may keep the name) and in the text of the docs
// (README.md, SETUP.md, CHANGELOG.md, RELEASING.md, AGENTS.md, package.json, docs/). The allowed forms are "Claude Agent" and "powered by Claude".
"use strict";

const fs = require("node:fs");
const path = require("node:path");

// What counts as a Pi specific (id, pattern, what it is):
const RULES = [
	{ id: "rpc-mode", re: /["'`]--mode["'`]\s*,\s*["'`]rpc["'`]|--mode rpc/, what: "Pi's RPC launch arguments" },
	{ id: "pi-folder", re: /["'`]~?[\\/]?\.pi["'`]|["'`]~?[\\/]?\.pi[\\/]|~[\\/]\.pi\b|[\\/]\.pi[\\/]|PI_CODING_AGENT_DIR/, what: "Pi's config folder (~/.pi/agent) or its override variable" },
	{ id: "pi-auth", re: /\bpi auth\b|["'`]auth["'`]\s*,\s*["'`]check["'`]/, what: "Pi's sign-in commands" },
	{ id: "pi-package", re: /@earendil-works|@mariozechner/, what: "Pi's npm package names" },
	{ id: "pi-binary", re: /\bPI_CRUST_PI\b/, what: "the override variable for Pi's program path" },
	{ id: "pi-probe", re: /__ready_probe__/, what: "Pi's readiness probe id" },
	{ id: "pi-status", re: /["'`]crust-context["'`]|["'`]permission-mode["'`]|["'`]copilot-usage["'`]/, what: "status names set by Pi-only extensions" },
	// everywhere: also reported inside the adapter folders, and in the docs. Spaces only, so identifiers such as the SDK's `claude_code` preset
	// or CLAUDE_CODE_* variables (code, never shown) are not hits.
	{ id: "claude-code-name", re: /claude[ \t ]+code/i, what: 'the product name "Claude Code" (use "Claude Agent")', everywhere: true },
];
// Text a user can read outside src/: scanned as plain text, comments included.
const DOC_FILES = ["README.md", "SETUP.md", "CHANGELOG.md", "RELEASING.md", "AGENTS.md", "package.json"];
const DOC_DIRS = ["docs"];
const DOC_EXT = /\.(md|txt|html|json)$/;
const SCAN_DIRS = ["src"];
const SCAN_EXT = /\.(js|mjs|cjs|html|ts)$/;
// Where Pi specifics belong: nothing is reported here.
const HOME = [/^src\/agents\/pi\//, /^src\/pi-extension\//];

function stripComments(text, file) {
	let t = text.replace(/\r\n/g, "\n").replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
	if (/\.html$/.test(file)) t = t.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "));
	return t
		.split("\n")
		.map((l) => l.replace(/^\s*\/\/.*$/, "").replace(/(\s)\/\/\s.*$/, "$1"))
		.join("\n");
}

function walk(root, dir, out, ext = SCAN_EXT) {
	let entries = [];
	try {
		entries = fs.readdirSync(path.join(root, dir), { withFileTypes: true });
	} catch {
		return out;
	}
	for (const e of entries) {
		const rel = `${dir}/${e.name}`;
		if (e.isDirectory()) {
			if (e.name === "node_modules" || e.name === "local" || e.name.startsWith(".")) continue; // src/local is the user's own, untracked
			walk(root, rel, out, ext);
		} else if (ext.test(e.name) && !/\.test\.js$/.test(e.name)) out.push(rel);
	}
	return out;
}

// -> [{ file, rule, line, text }] for every Pi specific outside HOME (allow-list not applied yet)
function scan(root) {
	const hits = [];
	for (const dir of SCAN_DIRS) {
		for (const file of walk(root, dir, [])) {
			const rules = HOME.some((re) => re.test(file)) ? RULES.filter((r) => r.everywhere) : RULES;
			const lines = stripComments(fs.readFileSync(path.join(root, file), "utf8"), file).split(/\r?\n/);
			lines.forEach((line, i) => {
				for (const r of rules) if (r.re.test(line)) hits.push({ file, rule: r.id, line: i + 1, text: line.trim().slice(0, 140), full: line });
			});
		}
	}
	const docs = DOC_FILES.slice();
	for (const dir of DOC_DIRS) for (const f of walk(root, dir, [], DOC_EXT)) docs.push(f);
	for (const file of docs) {
		let text;
		try {
			text = fs.readFileSync(path.join(root, file), "utf8");
		} catch {
			continue;
		}
		text.split(/\r?\n/).forEach((line, i) => {
			for (const r of RULES) if (r.everywhere && r.re.test(line)) hits.push({ file, rule: r.id, line: i + 1, text: line.trim().slice(0, 140), full: line });
		});
	}
	return hits;
}

// allow: { entries: [{ file, rule, contains, reason }] } -> { failures: [string], allowed: n, hits }
// An entry allows only the hits of its file and rule whose line contains its `contains` text, so a new Pi specific in the same file
// (same rule, other text) is reported. `contains` is required.
function check(root, allow) {
	const hits = scan(root);
	const failures = [];
	const entries = (allow && allow.entries) || [];
	const known = new Set(RULES.map((r) => r.id));
	for (const e of entries) {
		if (!e || typeof e.file !== "string" || typeof e.rule !== "string") failures.push(`allow-list entry without file and rule: ${JSON.stringify(e)}`);
		else if (typeof e.contains !== "string" || e.contains.trim().length < 6) failures.push(`allow-list entry ${e.file} (${e.rule}) has no "contains" text (at least 6 characters of the reviewed line)`);
		else if (!known.has(e.rule)) failures.push(`allow-list entry ${e.file}: unknown rule "${e.rule}"`);
		else if (typeof e.reason !== "string" || e.reason.trim().length < 12) failures.push(`allow-list entry ${e.file} (${e.rule}) has no reason`);
	}
	const valid = entries.filter((e) => e && typeof e.file === "string" && known.has(e.rule) && typeof e.contains === "string" && e.contains.trim().length >= 6);
	const used = new Set();
	let allowedHits = 0;
	for (const h of hits) {
		const e = valid.find((x) => x.file === h.file && x.rule === h.rule && h.full.includes(x.contains));
		if (e) (used.add(e), allowedHits++);
		else failures.push(`${h.file}:${h.line} [${h.rule}] ${RULES.find((r) => r.id === h.rule).what}: ${h.text}`);
	}
	for (const e of valid) if (!used.has(e)) failures.push(`stale allow-list entry: ${e.file} [${e.rule}] "${e.contains}" matches nothing any more, remove it`);
	return { failures, allowed: allowedHits, hits };
}

function main(argv) {
	let root = path.resolve(__dirname, "..");
	let allowFile = path.join(__dirname, "agent-boundary-allow.json");
	let list = false;
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--root") root = path.resolve(argv[++i]);
		else if (argv[i] === "--allow") allowFile = path.resolve(argv[++i]);
		else if (argv[i] === "--list") list = true;
		else return console.error("usage: node scripts/check-agent-boundary.js [--root <repo>] [--allow <file>] [--list]"), 2;
	}
	if (list) {
		for (const h of scan(root)) console.log(`${h.file}:${h.line} [${h.rule}] ${h.text}`);
		return 0;
	}
	let allow = { entries: [] };
	try {
		allow = JSON.parse(fs.readFileSync(allowFile, "utf8"));
	} catch (e) {
		if (e.code !== "ENOENT") return console.error(`cannot read ${allowFile}: ${e.message}`), 2;
	}
	const r = check(root, allow);
	if (r.failures.length) {
		console.error(`agent boundary: ${r.failures.length} problem(s)`);
		for (const f of r.failures) console.error(`  ${f}`);
		return 1;
	}
	console.log(`agent boundary: ok (${r.allowed} hit(s) in ${((allow.entries || []).length)} allow-listed place(s), none elsewhere)`);
	return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { RULES, scan, check, stripComments };
