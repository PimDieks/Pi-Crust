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
	const ok = { file: "src/a.js", rule: "pi-folder", reason: "a real reason, long enough to judge" };
	let r = B.check(root, { entries: [ok] });
	assert.strictEqual(r.failures.length, 1);
	assert.match(r.failures[0], /^src\/b\.js:1 \[pi-folder\]/);
	r = B.check(root, { entries: [ok, { file: "src/b.js", rule: "pi-folder", reason: "x" }] });
	assert.ok(r.failures.some((f) => /has no reason/.test(f)));
	r = B.check(root, { entries: [ok, { file: "src/b.js", rule: "pi-auth", reason: "wrong rule for this file, kept long" }] });
	assert.ok(r.failures.some((f) => /stale allow-list entry: src\/b\.js \[pi-auth\]/.test(f)) && r.failures.some((f) => /^src\/b\.js:1/.test(f)));
	r = B.check(root, { entries: [{ file: "src/a.js", rule: "nope", reason: "unknown rule, long enough here" }] });
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
	const hits = B.scan(root).filter((h) => ["src/main.js", "src/figma-bridge-main.js", "src/subscriptions-main.js"].includes(h.file));
	assert.deepStrictEqual(hits, []);
});
