"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { busyByShell, parse, checkAll } = require("../src/win-busy");

test("busyByShell ignores the console host, strips .exe, looks through a wrapper copy of the shell", () => {
	const P = (Name, ProcessId, ParentProcessId) => ({ Name, ProcessId, ParentProcessId });
	assert.strictEqual(busyByShell([], [{ pid: 1, exe: "bash.exe" }]).get(1), null);
	assert.strictEqual(busyByShell(null, null).size, 0);
	assert.strictEqual(busyByShell([P("conhost.exe", 2, 1), P("OpenConsole.exe", 3, 1)], [{ pid: 1, exe: "pwsh.exe" }]).get(1), null);
	assert.strictEqual(busyByShell([P("conhost.exe", 2, 1), P("node.exe", 3, 1)], [{ pid: 1, exe: "pwsh.exe" }]).get(1), "node");
	// Git Bash: binash.exe (1) -> usrinash.exe (2) -> idle; then -> sleep.exe
	const wrapped = [P("bash.exe", 2, 1), P("conhost.exe", 9, 2)];
	assert.strictEqual(busyByShell(wrapped, [{ pid: 1, exe: "bash.exe" }]).get(1), null);
	assert.strictEqual(busyByShell([...wrapped, P("sleep.exe", 5, 2)], [{ pid: 1, exe: "bash.exe" }]).get(1), "sleep");
	// two shells answered from one list
	const m = busyByShell([P("ping.exe", 5, 10)], [{ pid: 10, exe: "cmd.exe" }, { pid: 11, exe: "cmd.exe" }]);
	assert.strictEqual(m.get(10), "ping");
	assert.strictEqual(m.get(11), null);
});

test("parse: one object, an array, nothing", () => {
	assert.deepStrictEqual(parse('{"Name":"a.exe","ProcessId":1}'), [{ Name: "a.exe", ProcessId: 1 }]);
	assert.strictEqual(parse('[{"Name":"a"},{"Name":"b"}]').length, 2);
	assert.deepStrictEqual(parse(""), []);
});

test("checkAll on Windows: a pid without children is idle, a cmd.exe running ping is busy", { skip: process.platform !== "win32" }, async () => {
	const { spawn } = require("node:child_process");
	const sh = spawn(process.env.ComSpec || "cmd.exe", ["/c", "ping -n 20 127.0.0.1 >nul"], { windowsHide: true, stdio: "ignore" });
	await new Promise((r) => setTimeout(r, 800));
	const m = await new Promise((r) => checkAll([{ pid: 999999, exe: "cmd.exe" }, { pid: sh.pid, exe: "cmd.exe" }], r));
	sh.kill();
	assert.strictEqual(m.get(999999), null);
	assert.match(String(m.get(sh.pid)), /ping/i);
});

test("checkAll: the time limit gives undefined", { skip: process.platform !== "win32" }, async () => {
	const v = await new Promise((r) => checkAll([{ pid: 4, exe: "x.exe" }], r, { limitMs: 1 }));
	assert.strictEqual(v, undefined);
});
