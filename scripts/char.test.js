"use strict";
const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { normalizeString, normalizeValue, buildCapture, diffLines } = require("./char/run");

test("diffLines: identical is empty, a changed line shows as - and +", () => {
	assert.deepStrictEqual(diffLines("a\nb\nc\n", "a\nb\nc\n"), []);
	const d = diffLines("a\nb\nc\n", "a\nB\nc\n");
	assert.ok(d.includes("- b") && d.includes("+ B"));
});
test("diffLines: an added and a removed line, and a swap, are all seen", () => {
	assert.ok(diffLines("a\nb\n", "a\nb\nc\n").includes("+ c"));
	assert.ok(diffLines("a\nb\nc\n", "a\nc\n").includes("- b"));
	assert.ok(diffLines("a\nb\nc\nd\n", "a\nc\nb\nd\n").some((l) => /^[+-] /.test(l)));
});
test("normalizeString: both path spellings become the token, separators after it are unified", () => {
	const root = path.resolve("C:/work/app");
	const tokens = [[root, "<APP>"]];
	assert.strictEqual(normalizeString(`${root}\\src\\pi-extension\\a.ts`, tokens), "<APP>/src/pi-extension/a.ts");
	assert.strictEqual(normalizeString(`${root.replace(/\\/g, "/")}/src/x`, tokens), "<APP>/src/x");
	assert.strictEqual(normalizeString("no path here", tokens), "no path here");
	assert.strictEqual(normalizeString(`${root}-other`, tokens), `${root}-other`); // a longer name is not the root
});
test("normalizeValue walks objects and arrays", () => {
	const root = path.resolve("C:/work/app");
	assert.deepStrictEqual(normalizeValue({ a: [`${root}/x`], b: 1 }, [[root, "<APP>"]]), { a: ["<APP>/x"], b: 1 });
});
test("buildCapture: helper processes are a sorted set, agent processes keep their start order", () => {
	const chat = (n) => [{ seq: 1, dir: "meta", argv: ["--mode", "rpc", String(n)] }];
	const aux = (a) => [{ seq: 1, dir: "meta", argv: a }, { seq: 2, dir: "meta", exit: 1 }];
	const x = buildCapture({ events: [], procs: [chat(1), aux(["auth", "check", "--provider", "a"]), aux(["auth", "check", "--provider", "b"]), chat(2)] }, []);
	const y = buildCapture({ events: [], procs: [chat(1), aux(["auth", "check", "--provider", "b"]), chat(2), aux(["auth", "check", "--provider", "a"])] }, []);
	assert.strictEqual(x, y);
	const z = buildCapture({ events: [], procs: [chat(2), chat(1)] }, []);
	assert.notStrictEqual(buildCapture({ events: [], procs: [chat(1), chat(2)] }, []), z);
});
test("buildCapture: the additive agent field of pi:started is left out, nothing else is", () => {
	const started = (extra) => ({ src: "main", channel: "pi:started", payload: { chatId: "c", cwd: "/r", ...extra } });
	const a = buildCapture({ events: [started({})], procs: [] }, []);
	const b = buildCapture({ events: [started({ agent: { id: "pi", label: "Pi", capabilities: {} } })], procs: [] }, []);
	assert.strictEqual(a, b);
	assert.notStrictEqual(a, buildCapture({ events: [started({ other: 1 })], procs: [] }, [])); // any other new field still shows
	const rec = (p) => ({ src: "main", channel: "pi:record", payload: p });
	assert.notStrictEqual(buildCapture({ events: [rec({ agent: 1 })], procs: [] }, []), buildCapture({ events: [rec({})], procs: [] }, [])); // only pi:started
});
test("buildCapture: stderr events are their own sequence, so cross-pipe order does not matter", () => {
	const ev = (channel, n) => ({ src: "main", channel, payload: { n } });
	const a = buildCapture({ events: [ev("pi:record", 1), ev("pi:stderr", 2), ev("pi:exit", 3)], procs: [] }, []);
	const b = buildCapture({ events: [ev("pi:record", 1), ev("pi:exit", 3), ev("pi:stderr", 2)], procs: [] }, []);
	assert.strictEqual(a, b);
	const c = buildCapture({ events: [ev("pi:exit", 3), ev("pi:record", 1), ev("pi:stderr", 2)], procs: [] }, []);
	assert.notStrictEqual(a, c); // other events keep their order
});

test("the recorder plugin does nothing outside selftest mode, even with its env set", () => {
	const fs = require("node:fs");
	const os = require("node:os");
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "char-gate-"));
	const saved = { out: process.env.PI_CRUST_CHAR_OUT, tr: process.env.PI_CRUST_CHAR_TRANSCRIPT };
	process.env.PI_CRUST_CHAR_OUT = path.join(dir, "events.jsonl");
	process.env.PI_CRUST_CHAR_TRANSCRIPT = path.join(dir, "missing.json"); // reading it would throw
	try {
		const taps = [];
		const ctx = { selftest: false, addSendTap: (f) => taps.push(f) };
		assert.doesNotThrow(() => require("./char/plugin/char-main").register(ctx));
		assert.strictEqual(taps.length, 0);
		assert.strictEqual(fs.existsSync(process.env.PI_CRUST_CHAR_OUT), false);
	} finally {
		if (saved.out === undefined) delete process.env.PI_CRUST_CHAR_OUT;
		else process.env.PI_CRUST_CHAR_OUT = saved.out;
		if (saved.tr === undefined) delete process.env.PI_CRUST_CHAR_TRANSCRIPT;
		else process.env.PI_CRUST_CHAR_TRANSCRIPT = saved.tr;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
test("a stale plugin copy in src/local/ is removed at the start of a run, other local files are not touched", () => {
	const fs = require("node:fs");
	const os = require("node:os");
	const { removeStalePlugin, removePluginCopy, PLUGIN_FILES } = require("./char/run");
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "char-stale-"));
	try {
		const local = path.join(root, "local");
		assert.strictEqual(removeStalePlugin(local), false); // no folder: nothing to do
		fs.mkdirSync(local);
		for (const f of PLUGIN_FILES) fs.writeFileSync(path.join(local, f), "// stale");
		assert.strictEqual(removeStalePlugin(local), true);
		assert.strictEqual(fs.existsSync(local), false, "the emptied folder goes too");
		fs.mkdirSync(local);
		fs.writeFileSync(path.join(local, PLUGIN_FILES[0]), "// stale");
		fs.writeFileSync(path.join(local, "mine-main.js"), "// the user's own");
		assert.strictEqual(removeStalePlugin(local), true);
		assert.deepStrictEqual(fs.readdirSync(local), ["mine-main.js"]);
		// the cleanup after a run: only the plugin files, the folder only when the run made it
		for (const f of PLUGIN_FILES) fs.writeFileSync(path.join(local, f), "x");
		removePluginCopy(local, false);
		assert.deepStrictEqual(fs.readdirSync(local), ["mine-main.js"]);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
test("writeFixtures: files under the temp folder, <ENC:name> is the folder name Pi gives a working folder, mtimes are set", () => {
	const fs = require("node:fs");
	const os = require("node:os");
	const { writeFixtures, encodeCwd } = require("./char/run");
	const { sessionsDirFor } = require("../src/agents/pi/sessions");
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "char-fx-"));
	try {
		// the harness' encoding is the app's own (a change in Pi's folder naming must break the fixtures loudly)
		assert.strictEqual(path.basename(sessionsDirFor(path.join(tmp, "repo"), "/h")), encodeCwd(path.join(tmp, "repo")));
		writeFixtures([{ path: "home/sessions/<ENC:repo>/a.jsonl", content: "x", mtimeAgoSec: 600 }, { path: "plain.txt" }], tmp);
		const f = path.join(tmp, "home", "sessions", encodeCwd(path.join(tmp, "repo")), "a.jsonl");
		assert.strictEqual(fs.readFileSync(f, "utf8"), "x");
		assert.ok(Date.now() - fs.statSync(f).mtimeMs > 590_000);
		assert.strictEqual(fs.readFileSync(path.join(tmp, "plain.txt"), "utf8"), "");
		assert.doesNotThrow(() => writeFixtures(undefined, tmp));
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});
