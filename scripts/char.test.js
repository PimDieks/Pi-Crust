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
