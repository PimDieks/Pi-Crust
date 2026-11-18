"use strict";
// The Pi process driver (src/agents/pi/process.js): spawn arguments, JSONL framing, the readiness probe, exit and stop.
// A small Node script stands in for Pi. No real Pi, no model, no app window.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const P = require("../src/agents/pi/process");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-process-"));
const script = (name, body) => {
	const f = path.join(dir, name);
	fs.writeFileSync(f, body);
	return f;
};
// Answers the probe (get_state), then follows `after`.
const probeAnswerer = (after = "") => `
const argv = process.argv.slice(2);
process.stdin.setEncoding("utf8");
let buf = "";
process.stdin.on("data", (c) => {
	buf += c;
	let i;
	while ((i = buf.indexOf("\\n")) >= 0) {
		const line = buf.slice(0, i); buf = buf.slice(i + 1);
		const req = JSON.parse(line);
		if (req.type === "get_state") process.stdout.write(JSON.stringify({ type: "response", id: req.id, success: true, data: { sessionFile: "/s.jsonl", argv } }) + "\\n");
		${after}
	}
});
process.stdin.on("end", () => process.exit(0));
`;

function collect({ current = () => true } = {}) {
	const events = [];
	const sink = {
		isCurrent: (h) => current(h),
		ready: (h, data) => events.push(["ready", data]),
		record: (h, record) => events.push(["record", record]),
		stderr: (h, text) => events.push(["stderr", text]),
		exit: (h, info) => events.push(["exit", info]),
	};
	return { events, sink };
}
const until = async (fn, ms = 8000) => {
	for (let t = 0; t < ms && !fn(); t += 25) await new Promise((r) => setTimeout(r, 25));
	assert.ok(fn(), "condition not reached in time");
};

test("start: arguments (--mode rpc, four -e extensions, optional --session), cwd and ready data; the probe reply is not a record", async () => {
	const f = script("a.js", probeAnswerer());
	const { events, sink } = collect();
	const proc = P.start({ pi: { command: process.execPath, args: [f] }, cwd: dir, env: process.env, sessionRef: "/x/sess.jsonl" }, sink);
	await until(() => events.some((e) => e[0] === "ready"));
	const data = events.find((e) => e[0] === "ready")[1];
	assert.deepStrictEqual(data.argv.slice(0, 2), ["--mode", "rpc"]);
	const exts = data.argv.filter((_, i) => data.argv[i - 1] === "-e").map((p) => path.basename(p));
	assert.deepStrictEqual(exts, ["crust-context.ts", "crust-guard.ts", "advisor.ts", "permission-modes.ts"]);
	assert.deepStrictEqual(data.argv.slice(-2), ["--session", "/x/sess.jsonl"]);
	assert.strictEqual(events.filter((e) => e[0] === "record").length, 0);
	P.stop(proc);
	await until(() => events.some((e) => e[0] === "exit"));
	assert.strictEqual(events.find((e) => e[0] === "exit")[1].kind, "exit");
});

test("start: no --session without a sessionRef", async () => {
	const f = script("b.js", probeAnswerer());
	const { events, sink } = collect();
	const proc = P.start({ pi: { command: process.execPath, args: [f] }, cwd: dir, env: process.env }, sink);
	await until(() => events.some((e) => e[0] === "ready"));
	assert.ok(!events.find((e) => e[0] === "ready")[1].argv.includes("--session"));
	P.stop(proc);
});

test("framing: split on LF only, CR stripped, partial lines joined, blank lines skipped, junk reported as stderr text", async () => {
	const f = script(
		"c.js",
		probeAnswerer(`if (req.type === "prompt") {
			process.stdout.write('{"type":"agent_start"}\\r\\n');
			process.stdout.write('{"type":"message_');
			setTimeout(() => process.stdout.write('end","x":"a\\u2028b"}\\n\\n   \\nnot json\\n{"type":"agent_end"}\\n'), 30);
		}`),
	);
	const { events, sink } = collect();
	const proc = P.start({ pi: { command: process.execPath, args: [f] }, cwd: dir, env: process.env }, sink);
	await until(() => events.some((e) => e[0] === "ready"));
	proc.stdin.write(JSON.stringify({ id: "p1", type: "prompt" }) + "\n");
	await until(() => events.some((e) => e[0] === "record" && e[1].type === "agent_end"));
	assert.deepStrictEqual(
		events.filter((e) => e[0] !== "ready").map((e) => (e[0] === "record" ? e[1].type : `${e[0]}:${e[1]}`)),
		["agent_start", "message_end", "stderr:Unparseable record: not json", "agent_end"],
	);
	assert.strictEqual(events.find((e) => e[0] === "record" && e[1].type === "message_end")[1].x, "a b"); // U+2028 is not a line break here
	P.stop(proc);
});

test("a throwing sink.record is reported like unparseable output (same as before the move)", async () => {
	const f = script("d.js", probeAnswerer(`if (req.type === "prompt") process.stdout.write('{"type":"agent_start"}\\n');`));
	const events = [];
	const sink = { isCurrent: () => true, ready: (h, d) => events.push(["ready"]), record: () => { throw new Error("boom"); }, stderr: (h, t) => events.push(["stderr", t]), exit: () => {} };
	const proc = P.start({ pi: { command: process.execPath, args: [f] }, cwd: dir, env: process.env }, sink);
	await until(() => events.some((e) => e[0] === "ready"));
	proc.stdin.write(JSON.stringify({ id: "p1", type: "prompt" }) + "\n");
	await until(() => events.some((e) => e[0] === "stderr"));
	assert.match(events.find((e) => e[0] === "stderr")[1], /^Unparseable record: \{"type":"agent_start"\}/);
	P.stop(proc);
});

test("a replaced handle: its output is dropped, its exit is still reported", async () => {
	const f = script("e.js", probeAnswerer(`if (req.type === "prompt") { process.stdout.write('{"type":"agent_start"}\\n'); process.stderr.write("err\\n"); }`));
	let cur = true;
	const { events, sink } = collect({ current: () => cur });
	const proc = P.start({ pi: { command: process.execPath, args: [f] }, cwd: dir, env: process.env }, sink);
	await until(() => events.some((e) => e[0] === "ready"));
	cur = false;
	proc.stdin.write(JSON.stringify({ id: "p1", type: "prompt" }) + "\n");
	await new Promise((r) => setTimeout(r, 300));
	assert.deepStrictEqual(events.map((e) => e[0]), ["ready"]);
	P.stop(proc);
	await until(() => events.some((e) => e[0] === "exit"));
});

test("exit info: code and signal; a missing program is kind error with ENOENT", async () => {
	const f = script("f.js", "process.exit(3);");
	const { events, sink } = collect();
	P.start({ pi: { command: process.execPath, args: [f] }, cwd: dir, env: process.env }, sink);
	await until(() => events.some((e) => e[0] === "exit"));
	assert.deepStrictEqual(events.find((e) => e[0] === "exit")[1], { kind: "exit", code: 3, signal: null });
	const b = collect();
	P.start({ pi: { command: path.join(dir, "no-such-program"), args: [] }, cwd: dir, env: process.env }, b.sink);
	await until(() => b.events.some((e) => e[0] === "exit"));
	const info = b.events.find((e) => e[0] === "exit")[1];
	assert.strictEqual(info.kind, "error");
	assert.strictEqual(info.errorCode, "ENOENT");
});

test("stop: closes stdin first; a program that ignores it is killed (tree kill) after about 1.5 s", async () => {
	const f = script("g.js", `process.stdin.resume(); setInterval(() => {}, 1000);`);
	const { events, sink } = collect();
	const t0 = Date.now();
	const proc = P.start({ pi: { command: process.execPath, args: [f] }, cwd: dir, env: process.env }, sink);
	await new Promise((r) => setTimeout(r, 400));
	P.stop(proc);
	await until(() => events.some((e) => e[0] === "exit"), 8000);
	assert.ok(Date.now() - t0 >= 1400, "killed too early");
	assert.ok(proc.exitCode !== null || proc.signalCode !== null);
	P.stop(proc); // a second stop on a dead process is harmless
	P.stop(null);
});

test("constants keep their values", () => {
	assert.strictEqual(P.PROBE_ID, "__ready_probe__");
	assert.strictEqual(P.PROBE_INTERVAL_MS, 750);
	assert.strictEqual(P.READY_TIMEOUT_MS, 120000);
});
