"use strict";
// The process "exit" backstop (src/exit-backstop.js): after a crash no chat's agent may be left running. Chats are
// { id, agent, handle, cwd } since phase 6; the first version of the backstop still read chat.proc and threw inside the exit handler.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { killAllSync } = require("../src/exit-backstop");

const fakeAgent = (state, log, throwOn) => ({
	state: (h) => {
		if (throwOn === "state") throw new Error("state failed");
		return state(h);
	},
	killRemains: (h, opts) => {
		log.push({ h, opts });
		if (throwOn === "kill") throw new Error("ESRCH");
	},
});

test("a fake chat table: every running chat gets a synchronous kill through its adapter, nothing throws", () => {
	const log = [];
	const running = fakeAgent(() => ({ pid: 1, exitCode: null, signalCode: null }), log);
	const ended = fakeAgent(() => ({ pid: 2, exitCode: 0, signalCode: null }), log);
	const chats = new Map([
		["chat-1", { id: "chat-1", agent: running, handle: "h1", cwd: "/r" }],
		["chat-2", { id: "chat-2", agent: ended, handle: "h2", cwd: null }],
		["chat-3", { id: "chat-3", agent: running, handle: "h3", cwd: null }],
	]);
	let n;
	assert.doesNotThrow(() => (n = killAllSync(chats.values())));
	assert.strictEqual(n, 2);
	assert.deepStrictEqual(log, [{ h: "h1", opts: { sync: true } }, { h: "h3", opts: { sync: true } }]);
});

test("one chat failing (state or kill throws) does not stop the others and never throws", () => {
	for (const throwOn of ["state", "kill"]) {
		const log = [];
		const bad = fakeAgent(() => ({ exitCode: null, signalCode: null }), [], throwOn);
		const good = fakeAgent(() => ({ exitCode: null, signalCode: null }), log);
		assert.doesNotThrow(() => killAllSync([{ agent: bad, handle: "a" }, { agent: good, handle: "b" }].values()));
		assert.strictEqual(log.length, 1, throwOn);
	}
	assert.doesNotThrow(() => killAllSync([].values()));
});

test("the Pi adapter really ends a live process tree root through the backstop", async () => {
	const pi = require("../src/agents/pi");
	const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["pipe", "ignore", "ignore"], detached: process.platform !== "win32", windowsHide: true });
	await new Promise((r) => child.once("spawn", r));
	const exited = new Promise((r) => child.once("exit", r));
	assert.strictEqual(child.exitCode, null);
	killAllSync([{ id: "chat-1", agent: pi, handle: child, cwd: null }].values());
	await Promise.race([exited, new Promise((_, rej) => setTimeout(() => rej(new Error("the process was not killed")), 10000))]);
	assert.ok(child.exitCode !== null || child.signalCode !== null);
});

test("main.js wires the exit handler to the backstop (not its own loop over chat.proc)", () => {
	const main = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
	assert.match(main, /process\.on\("exit",\s*\(\)\s*=>\s*require\("\.\/exit-backstop"\)\.killAllSync\(chats\.values\(\)\)\)/);
	assert.ok(!/\{\s*proc\s*\}\s*of\s*chats/.test(main), "no destructuring of chat.proc");
});
