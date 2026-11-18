"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const A = require("../src/agents/adapter");
const { createRegistry, DEFAULT_ID } = require("../src/agents/registry");

const good = () => ({
	id: "pi",
	label: "Pi",
	capabilities: A.capabilities(),
	strings: { notRunning: "Pi is not running" },
	locate: () => null,
	pathExtras: () => [],
	start() {},
	canSend: () => true,
	state: () => ({ pid: 1, exitCode: null, signalCode: null }),
	onceExit() {},
	killRemains() {},
	send: () => true,
	stop() {},
	listSessions: () => [],
	auth: null,
	mcpConfigPath: () => null,
	onAppStart() {},
});

test("a complete adapter passes", () => {
	assert.doesNotThrow(() => A.assertAdapter(good()));
});
test("each missing function is rejected by name", () => {
	for (const f of A.REQUIRED_FUNCTIONS) {
		const a = good();
		delete a[f];
		assert.throws(() => A.assertAdapter(a), new RegExp(`missing function ${f}`));
	}
});
test("capabilities: missing, unknown and wrong-typed keys are rejected", () => {
	let a = good();
	delete a.capabilities.steering;
	assert.throws(() => A.assertAdapter(a), /capabilities\.steering is missing/);
	a = good();
	a.capabilities.bogus = true;
	assert.throws(() => A.assertAdapter(a), /unknown capability bogus/);
	a = good();
	a.capabilities.images = "yes";
	assert.throws(() => A.assertAdapter(a), /images must be a boolean/);
	a = good();
	a.capabilities.permissionModes = [{ id: 1 }];
	assert.throws(() => A.assertAdapter(a), /permissionModes/);
	assert.throws(() => A.capabilities({ nope: true }), /unknown capability/);
});
test("permissionModes may be null; auth must be null or complete", () => {
	const a = good();
	a.capabilities = A.capabilities({ permissionModes: null });
	assert.doesNotThrow(() => A.assertAdapter(a));
	a.auth = { status() {} };
	assert.throws(() => A.assertAdapter(a), /auth must be null/);
	a.auth = { status() {}, login() {}, logout() {} };
	assert.doesNotThrow(() => A.assertAdapter(a));
});
test("Pi defaults: every flag on, ready only after a probe, four permission modes", () => {
	const c = A.allOn();
	for (const k of A.CAPABILITY_FLAGS) assert.strictEqual(c[k], true, k);
	assert.strictEqual(c.readyOnSpawn, false);
	assert.deepStrictEqual(c.permissionModes.map((m) => m.id), ["plan", "ask-edits", "ask-commands", "trusted"]);
	assert.notStrictEqual(A.allOn().permissionModes, A.allOn().permissionModes); // fresh copies
});
test("registry: register, get, default, duplicate, invalid", () => {
	const r = createRegistry();
	assert.strictEqual(r.get(), null);
	r.register(good());
	assert.strictEqual(DEFAULT_ID, "pi");
	assert.strictEqual(r.get().id, "pi");
	assert.strictEqual(r.get("nope"), null);
	assert.deepStrictEqual(r.ids(), ["pi"]);
	assert.throws(() => r.register(good()), /already registered/);
	const bad = good();
	bad.id = "x";
	delete bad.send;
	assert.throws(() => r.register(bad), /missing function send/);
	assert.deepStrictEqual(r.ids(), ["pi"]);
});
// Drift guard: the written-down contract must still match the code that consumes it.
test("record types and ui methods are still handled by the renderer", () => {
	const src = fs.readFileSync(path.join(__dirname, "..", "src", "renderer.js"), "utf8");
	for (const t of A.RECORD_TYPES) assert.ok(src.includes(`case "${t}"`), `renderer has no case for record ${t}`);
	for (const m of A.UI_METHODS) assert.ok(src.includes(`case "${m}"`), `renderer has no case for ui method ${m}`);
});
test("request types are still used somewhere in src/", () => {
	const dir = path.join(__dirname, "..", "src");
	const all = fs.readdirSync(dir).filter((f) => f.endsWith(".js") && !f.endsWith(".test.js")).map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("\n");
	for (const t of A.REQUEST_TYPES) assert.ok(all.includes(`"${t}"`), `no source uses request ${t}`);
});
