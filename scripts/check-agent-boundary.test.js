"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const B = require("./check-agent-boundary");

const SCRIPT = path.join(__dirname, "check-agent-boundary.js");
function tree(files) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-boundary-"));
	for (const [f, text] of Object.entries(files)) {
		fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
		fs.writeFileSync(path.join(root, f), text);
	}
	return root;
}
const rules = (r) => r.hits.map((h) => `${h.file}:${h.rule}`).sort();

test("each rule catches its Pi specific outside the adapter", () => {
	const root = tree({
		"src/a.js": 'const args = ["--mode", "rpc"];\n',
		"src/b.js": 'const p = path.join(os.homedir(), ".pi", "agent");\nconst d = process.env.PI_CODING_AGENT_DIR;\n',
		"src/c.js": 'execFile(cmd, ["auth", "check", "--provider", id]);\n',
		"src/d.js": 'const n = "@earendil-works/pi-coding-agent";\n',
		"src/e.js": "const g = process.env.PI_CRUST_PI;\n",
		"src/f.js": 'const PROBE_ID = "__ready_probe__";\n',
		"src/g.js": 'statuses.get("crust-context");\n',
	});
	assert.deepStrictEqual(rules(B.check(root, { entries: [] })), ["src/a.js:rpc-mode", "src/b.js:pi-folder", "src/b.js:pi-folder", "src/c.js:pi-auth", "src/d.js:pi-package", "src/e.js:pi-binary", "src/f.js:pi-probe", "src/g.js:pi-status"]);
	assert.strictEqual(B.check(root, { entries: [] }).failures.length, 8);
});

test("the adapter folder, the extension folder, tests and comments are not reported", () => {
	const root = tree({
		"src/agents/pi/x.js": 'const a = ["--mode", "rpc"]; const p = ".pi";\n',
		"src/pi-extension/y.ts": 'const k = "crust-context";\n',
		"src/z.js": '// the ~/.pi/agent folder and --mode rpc, in prose\n/* block: @earendil-works/pi */\nconst x = 1; // PI_CODING_AGENT_DIR in a trailing comment\n',
		"src/z.test.js": 'const a = "--mode rpc";\n',
		"src/local/mine.js": 'const a = "--mode rpc";\n',
		"src/page.html": "<!-- .pi/agent -->\n<p>hello</p>\n",
	});
	assert.deepStrictEqual(B.check(root, { entries: [] }).failures, []);
	assert.deepStrictEqual(B.scan(root), []);
});

test("allow-list: an entry with a reason allows its file and rule only; stale, unknown and reasonless entries fail", () => {
	const root = tree({ "src/a.js": 'const d = process.env.PI_CODING_AGENT_DIR;\n', "src/b.js": 'const d = process.env.PI_CODING_AGENT_DIR;\n' });
	const ok = { file: "src/a.js", rule: "pi-folder", contains: "process.env.PI_CODING_AGENT_DIR", reason: "a real reason, long enough to judge" };
	let r = B.check(root, { entries: [ok] });
	assert.strictEqual(r.failures.length, 1);
	assert.match(r.failures[0], /^src\/b\.js:1 \[pi-folder\]/);
	r = B.check(root, { entries: [ok, { file: "src/b.js", rule: "pi-folder", contains: "PI_CODING_AGENT_DIR", reason: "x" }] });
	assert.ok(r.failures.some((f) => /has no reason/.test(f)));
	r = B.check(root, { entries: [ok, { file: "src/b.js", rule: "pi-auth", contains: "auth check", reason: "wrong rule for this file, kept long" }] });
	assert.ok(r.failures.some((f) => /stale allow-list entry: src\/b\.js \[pi-auth\]/.test(f)) && r.failures.some((f) => /^src\/b\.js:1/.test(f)));
	r = B.check(root, { entries: [{ file: "src/a.js", rule: "nope", contains: "anything here", reason: "unknown rule, long enough here" }] });
	assert.ok(r.failures.some((f) => /unknown rule "nope"/.test(f)));
	const gone = tree({ "src/a.js": "const x = 1;\n" });
	assert.ok(B.check(gone, { entries: [ok] }).failures.some((f) => /stale allow-list entry/.test(f)));
});

test("CRLF files are read the same way (comments end at the line end)", () => {
	const root = tree({ "src/a.js": "// ~/.pi/agent in a comment\r\nconst x = 1;\r\n" });
	assert.deepStrictEqual(B.scan(root), []);
});

test("the command: exit 1 on a hit, 0 when clean, 2 on bad usage", () => {
	const dirty = tree({ "src/a.js": 'const a = ["--mode", "rpc"];\n' });
	const clean = tree({ "src/a.js": "const a = 1;\n" });
	const run = (...a) => spawnSync(process.execPath, [SCRIPT, ...a], { encoding: "utf8" });
	assert.strictEqual(run("--root", dirty, "--allow", path.join(dirty, "none.json")).status, 1);
	assert.strictEqual(run("--root", clean, "--allow", path.join(clean, "none.json")).status, 0);
	assert.strictEqual(run("--bogus").status, 2);
});

test("this repository: no Pi specific outside src/agents/pi/, src/pi-extension/ and the allow-list", () => {
	const allow = JSON.parse(fs.readFileSync(path.join(__dirname, "agent-boundary-allow.json"), "utf8"));
	const r = B.check(path.join(__dirname, ".."), allow);
	assert.deepStrictEqual(r.failures, []);
	for (const e of allow.entries) assert.ok(e.reason.length >= 40, `${e.file}: a short reason`);
});

test("the files the check protects: main.js and the Figma bridge hold nothing that is Pi's", () => {
	const root = path.join(__dirname, "..");
	const hits = B.scan(root).filter((h) => ["src/figma-bridge-main.js", "src/subscriptions-main.js"].includes(h.file) || (h.file === "src/main.js" && h.rule !== "pi-folder"));
	assert.deepStrictEqual(hits, []);
});

test("an entry allows only the reviewed line: a new Pi specific in the same file and rule fails", () => {
	const entry = { file: "src/main.js", rule: "pi-folder", contains: "findOldCopy(ENV.PI_CODING_AGENT_DIR", reason: "the reviewed old-copy lookup, long enough" };
	const old = 'const found = findOldCopy(ENV.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"));\n';
	assert.deepStrictEqual(B.check(tree({ "src/main.js": old }), { entries: [entry] }).failures, []);
	const added = tree({ "src/main.js": old + 'const mcp = path.join(os.homedir(), ".pi", "agent", "mcp.json");\n' });
	const r = B.check(added, { entries: [entry] });
	assert.strictEqual(r.failures.length, 1);
	assert.match(r.failures[0], /^src\/main\.js:2 \[pi-folder\]/);
	// the reviewed line changing to something else is a stale entry plus a hit
	const changed = B.check(tree({ "src/main.js": "const x = process.env.PI_CODING_AGENT_DIR;\n" }), { entries: [entry] });
	assert.ok(changed.failures.some((f) => /stale allow-list entry/.test(f)) && changed.failures.some((f) => /^src\/main\.js:1/.test(f)));
	// an entry without a usable contains text is refused
	assert.ok(B.check(tree({ "src/main.js": old }), { entries: [{ ...entry, contains: undefined }] }).failures.some((f) => /no "contains" text/.test(f)));
});

test("the pi-folder rule also catches the folder written as one string", () => {
	const root = tree({
		"src/a.js": 'const a = "~/.pi";\n',
		"src/b.js": 'const b = ".pi/agent";\n',
		"src/c.js": "const c = `~/.pi/agent/mcp.json`;\n",
		"src/d.js": 'const d = "C:\\\\Users\\\\x\\\\.pi\\\\agent";\n',
		"src/e.js": 'const fine = "pi-crust" + "split";\n',
	});
	assert.deepStrictEqual(rules(B.check(root, { entries: [] })), ["src/a.js:pi-folder", "src/b.js:pi-folder", "src/c.js:pi-folder", "src/d.js:pi-folder"]);
});

test("this repository: a new .pi use in src/main.js fails, the allowed ones pass", () => {
	const root = path.join(__dirname, "..");
	const allow = JSON.parse(fs.readFileSync(path.join(__dirname, "agent-boundary-allow.json"), "utf8"));
	assert.deepStrictEqual(B.check(root, allow).failures, []);
	const mainEntries = allow.entries.filter((e) => e.file === "src/main.js");
	const real = fs.readFileSync(path.join(root, "src/main.js"), "utf8");
	// the real file with its allowed line: passes; with one more Pi specific appended: exactly that line fails
	assert.deepStrictEqual(B.check(tree({ "src/main.js": real }), { entries: mainEntries }).failures, []);
	const r = B.check(tree({ "src/main.js": real + '\nconst extra = path.join(os.homedir(), ".pi", "agent", "extra.json");\n' }), { entries: mainEntries });
	assert.strictEqual(r.failures.length, 1, r.failures.join("\n"));
	assert.match(r.failures[0], /^src\/main\.js:\d+ \[pi-folder\].*extra\.json/);
	for (const e of allow.entries) assert.ok(e.contains && e.contains.length >= 6, `${e.file}: a contains text`);
});
