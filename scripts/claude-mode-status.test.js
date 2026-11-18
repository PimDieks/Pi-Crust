"use strict";
// Claude adapter: the permission mode status (phase 7). The selector shows a mode as enforced only after the adapter has installed both the
// PreToolUse hook and the approval callback, and a change from the selector (the "/crust-mode <id>" request) reaches the adapter and the SDK.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");
const { createClaudeAdapter } = require("../src/agents/claude");

const STAND_IN = path.join(__dirname, "claude-sdk-stand-in.mjs");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "claude-mode-"));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

async function rig({ configDir = fs.mkdtempSync(path.join(tmp, "cfg-")) } = {}) {
	const sdk = await import(pathToFileURL(STAND_IN).href);
	sdk.reset();
	const cwd = fs.mkdtempSync(path.join(tmp, "proj-"));
	const keystore = { read: async () => ({ source: "stored", key: "sk-ant-test-DUMMYKEY-0123456789" }), status: async () => ({ source: "stored" }), set: async () => ({ ok: true }), clear: async () => ({ ok: true }) };
	const adapter = createClaudeAdapter({ keystore, configDir, isPackaged: () => false, loadSdk: async () => sdk, killTree: () => {}, getSettings: () => ({}), env: {} });
	const records = [];
	const sink = { isCurrent: () => true, ready() {}, record: (h, r) => records.push(r), stderr() {}, exit() {} };
	const until = async (f, ms = 3000) => {
		const t = Date.now();
		while (!f()) {
			if (Date.now() - t > ms) throw new Error("timed out");
			await new Promise((r) => setTimeout(r, 5));
		}
	};
	const modes = () => records.filter((r) => r.type === "extension_ui_request" && r.statusKey === "permission-mode").map((r) => r.statusText);
	const answered = (id) => records.some((r) => r.type === "response" && r.id === id);
	const answer = (id) => records.find((r) => r.type === "response" && r.id === id);
	return { sdk, adapter, cwd, records, sink, until, modes, answered, answer, configDir };
}

test("the mode is reported once the hook and the approval callback are installed, and not before", async () => {
	const t = await rig();
	const h = t.adapter.start({ cwd: t.cwd }, t.sink);
	assert.deepStrictEqual(t.modes(), [], "nothing is reported at once");
	assert.strictEqual(h.gateInstalled, false);
	await t.until(() => t.modes().length === 1);
	const opts = t.sdk.calls[0].options;
	assert.ok(opts, "the query was started");
	assert.strictEqual(h.gateInstalled, true);
	assert.strictEqual(typeof h.canUseTool, "function");
	assert.deepStrictEqual(t.modes(), ["Mode: Ask before commands"], "a first run starts in Ask before commands");
	t.adapter.stop(h);
});

test("no key: no mode is reported (nothing is installed)", async () => {
	const sdk = await import(pathToFileURL(STAND_IN).href);
	sdk.reset();
	const records = [];
	const adapter = createClaudeAdapter({ keystore: { read: async () => ({ source: "none", key: null }), status: async () => ({ source: "none" }) }, configDir: tmp, isPackaged: () => false, loadSdk: async () => sdk, killTree: () => {}, env: {} });
	const exits = [];
	adapter.start({ cwd: tmp }, { isCurrent: () => true, ready() {}, record: (h, r) => records.push(r), exit: (h, i) => exits.push(i) });
	await new Promise((r) => setTimeout(r, 100));
	assert.strictEqual(exits.length, 1);
	assert.deepStrictEqual(records.filter((r) => r.statusKey === "permission-mode"), []);
});

test("a requested mode that is not one of the four falls back to Ask before commands, never to Trusted", async () => {
	const t = await rig();
	const h = t.adapter.start({ cwd: t.cwd, mode: "yolo" }, t.sink);
	await t.until(() => t.modes().length === 1);
	assert.deepStrictEqual(t.modes(), ["Mode: Ask before commands"]);
	assert.strictEqual(h.mode, "ask-commands");
	t.adapter.stop(h);
});

test("/crust-mode reaches the adapter: the gate, the SDK, the status and the answer; the model never sees it", async () => {
	const t = await rig();
	const h = t.adapter.start({ cwd: t.cwd }, t.sink);
	await t.until(() => t.modes().length === 1);
	h.canUseTool.grants.edits = true;
	h.canUseTool.grants.keys.add("x");
	assert.strictEqual(t.adapter.send(h, { id: 11, type: "prompt", message: "/crust-mode plan" }), true);
	await t.until(() => t.answered(11));
	const resp = t.answer(11);
	assert.deepStrictEqual({ s: resp.success, d: resp.data && resp.data.disposition }, { s: true, d: "handled" });
	assert.strictEqual(h.mode, "plan");
	assert.deepStrictEqual(t.modes(), ["Mode: Ask before commands", "Mode: Plan (read-only)"]);
	const statusAt = t.records.findIndex((r) => r.statusText === "Mode: Plan (read-only)");
	assert.ok(statusAt >= 0 && statusAt < t.records.indexOf(resp), "the status comes before the answer");
	assert.strictEqual(h.canUseTool.grants.edits, false);
	assert.strictEqual(h.canUseTool.grants.keys.size, 0, "grants are cleared on a mode change");
	assert.deepStrictEqual(t.sdk.calls[0].modes, ["plan"]);
	assert.ok(!t.sdk.calls[0].calls.includes("user_message"), "the request was not sent to the model");
	assert.ok(!t.records.some((r) => r.type === "message_start" && r.message && r.message.role === "user"), "no user row");
	// the gate now judges in Plan
	const d = await h.canUseTool("Write", { file_path: path.join(t.cwd, "a.txt"), content: "x" }, { signal: new AbortController().signal });
	assert.strictEqual(d.behavior, "deny");
	t.adapter.stop(h);
});

test("Trusted from a chat that did not start in Trusted stays 'default' on the SDK side; the choice is remembered for the next chat", async () => {
	const t = await rig();
	const h = t.adapter.start({ cwd: t.cwd }, t.sink);
	await t.until(() => t.modes().length === 1);
	t.adapter.send(h, { id: 1, type: "prompt", message: "/crust-mode trusted" });
	await t.until(() => t.answered(1));
	assert.deepStrictEqual(t.sdk.calls[0].modes, ["default"], "no bypassPermissions without the start flag");
	assert.strictEqual(h.mode, "trusted");
	t.adapter.stop(h);
	const h2 = t.adapter.start({ cwd: t.cwd }, t.sink);
	await t.until(() => t.modes().length === 3);
	assert.strictEqual(t.modes()[2], "Mode: Trusted");
	assert.strictEqual(t.sdk.calls[1].options.permissionMode, "bypassPermissions");
	t.adapter.send(h2, { id: 2, type: "prompt", message: "/crust-mode ask-edits" });
	await t.until(() => t.answered(2));
	t.adapter.send(h2, { id: 3, type: "prompt", message: "/crust-mode trusted" });
	await t.until(() => t.answered(3));
	assert.deepStrictEqual(t.sdk.calls[1].modes, ["default", "bypassPermissions"]);
	t.adapter.stop(h2);
});

test("an unknown mode is refused and the mode stays; an unreadable remembered mode gives the default", async () => {
	const t = await rig();
	fs.writeFileSync(path.join(t.configDir, "crust-permission-mode.json"), "not json");
	const h = t.adapter.start({ cwd: t.cwd }, t.sink);
	await t.until(() => t.modes().length === 1);
	assert.deepStrictEqual(t.modes(), ["Mode: Ask before commands"]);
	t.adapter.send(h, { id: 5, type: "prompt", message: "/crust-mode bogus" });
	await t.until(() => t.answered(5));
	assert.strictEqual(t.answer(5).success, false);
	assert.strictEqual(h.mode, "ask-commands");
	assert.deepStrictEqual(t.modes(), ["Mode: Ask before commands"], "no new status");
	t.adapter.stop(h);
});

test("the SDK refusing the switch leaves the mode unchanged and says so", async () => {
	const t = await rig();
	const h = t.adapter.start({ cwd: t.cwd }, t.sink);
	await t.until(() => t.modes().length === 1);
	h.query.setPermissionMode = async () => {
		throw new Error("no");
	};
	t.adapter.send(h, { id: 9, type: "prompt", message: "/crust-mode plan" });
	await t.until(() => t.answered(9));
	assert.strictEqual(t.answer(9).success, false);
	assert.strictEqual(h.mode, "ask-commands");
	assert.strictEqual(t.modes().length, 1);
	t.adapter.stop(h);
});
