"use strict";
// The Pi adapter object (src/agents/pi/index.js) and what the core keeps of Pi's texts and process handling.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const A = require("../src/agents/adapter");
const pi = require("../src/agents/pi");
const { createRegistry } = require("../src/agents/registry");

const main = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");

test("the Pi adapter satisfies the contract and registers as the default agent", () => {
	assert.doesNotThrow(() => A.assertAdapter(pi));
	const r = createRegistry();
	r.register(pi);
	assert.strictEqual(r.get(), pi);
	assert.strictEqual(pi.id, "pi");
	assert.strictEqual(pi.label, "Pi");
	assert.strictEqual(pi.capabilities.readyOnSpawn, false);
});

test("string parity: the main-side texts are exactly what main.js wrote inline before the move", () => {
	assert.deepStrictEqual(pi.strings, {
		notInstalled: "Pi is not installed",
		notRunning: "Pi is not running",
		stopped: "Pi stopped",
		noAnswer: "Pi did not answer in time",
		refused: "Pi refused the request",
	});
});

test("main.js holds none of those texts inline any more, and never touches a process's stdin", () => {
	for (const t of Object.values(pi.strings)) assert.ok(!main.includes(`"${t}"`), `main.js still has "${t}"`);
	assert.ok(!/\.stdin\b/.test(main.replace(/\/\/.*$/gm, "")), "main.js touches .stdin");
});

test("mcpConfigPath is the home folder's Pi file, not PI_CODING_AGENT_DIR (as the Figma bridge always read it)", () => {
	const saved = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = path.join(__dirname, "somewhere-else");
	try {
		assert.strictEqual(pi.mcpConfigPath(), path.join(require("node:os").homedir(), ".pi", "agent", "mcp.json"));
	} finally {
		if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = saved;
	}
});

test("state, onceExit and killRemains read a process without exposing more", async () => {
	const { spawn } = require("node:child_process");
	const p = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60)"], { stdio: "ignore" });
	const st = pi.state(p);
	assert.deepStrictEqual(Object.keys(st).sort(), ["exitCode", "pid", "signalCode"]);
	assert.strictEqual(st.pid, p.pid);
	assert.strictEqual(st.exitCode, null);
	await new Promise((r) => pi.onceExit(p, r));
	assert.strictEqual(pi.state(p).exitCode, 0);
	assert.doesNotThrow(() => { try { pi.killRemains(p); } catch (e) { if (e.code !== "ESRCH") throw e; } });
});

test("send and canSend: false without a process or with a closed stdin, one JSON line otherwise", () => {
	assert.strictEqual(pi.canSend(undefined), false);
	assert.strictEqual(pi.send(undefined, { a: 1 }), false);
	const written = [];
	const open = { stdin: { writable: true, write: (t) => written.push(t) } };
	assert.strictEqual(pi.canSend(open), true);
	assert.strictEqual(pi.send(open, { id: "x", type: "get_state" }), true);
	assert.deepStrictEqual(written, [JSON.stringify({ id: "x", type: "get_state" }) + "\n"]);
	const closed = { stdin: { writable: false, write: () => assert.fail("wrote to a closed stdin") } };
	assert.strictEqual(pi.canSend(closed), false);
	assert.strictEqual(pi.send(closed, {}), false);
});
