"use strict";
// The phone remote view is Pi-only (Pim, 2026-11-18). Tested at the hub's boundary: remote-main.js registered against a fake app context with the real hub
// wrapped in a spy. A Claude Agent chat must not be listed, shared or controlled, and nothing about it (records, key state, cost) may reach the hub.
// A Pi chat in the same run is the control: it must reach the hub, or the test could not tell "filtered" from "never wired".
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "remote-pi-only-"));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// remote-main.js takes powerSaveBlocker and shell from electron: a stand-in for this process only.
const realLoad = Module._load;
Module._load = function (request, ...rest) {
	if (request === "electron") return { powerSaveBlocker: { start: () => 1, stop() {} }, shell: { openExternal() {} } };
	return realLoad.call(this, request, ...rest);
};
test.after(() => {
	Module._load = realLoad;
});

const state = require("../src/remote-state");
const seen = []; // every call that reaches the hub: [method, chatId]
const realCreateHub = state.createHub;
state.createHub = (...a) => {
	const hub = realCreateHub(...a);
	return new Proxy(hub, {
		get(t, k) {
			const v = t[k];
			if (typeof v !== "function") return v;
			return (...args) => {
				seen.push([String(k), args[0] && typeof args[0] === "object" ? args[0].chatId : args[0], args[1] && args[1].chatId]);
				return v.apply(t, args);
			};
		},
	});
};
const { register } = require("../src/remote-main");

function rig() {
	const handlers = new Map();
	let tap = null;
	const sent = [];
	const open = [
		{ id: "chat-1", file: path.join(tmp, "pi.jsonl"), cwd: tmp, agent: "pi", running: true },
		{ id: "chat-2", file: path.join(tmp, "claude.jsonl"), cwd: tmp, agent: "claude", running: true },
	];
	const requests = [];
	const ctx = {
		selftest: false,
		repo: tmp,
		ipcMain: { handle: (n, f) => handlers.set(n, f) },
		app: { getPath: () => tmp, whenReady: () => new Promise(() => {}), on() {} },
		send: (ch, p) => sent.push([ch, p]),
		addSendTap: (f) => ((tap = f), () => {}),
		openChats: () => open,
		piRequest: async (...a) => (requests.push(a), { success: true, data: {} }),
		piSend: () => true,
		answerUi: async () => true,
		stopChat: async () => {},
		heldTake: () => ({}),
		newChat: async () => "chat-9",
		restartChat: async () => true,
	};
	register(ctx);
	return { handlers, tap: (c, p) => tap(c, p), sent, open, requests };
}

const started = (chatId, extra = {}) => ({ chatId, cwd: tmp, sessionFile: null, ...extra });
const record = (chatId, record) => ({ chatId, record });
const hubChats = () => new Set(seen.filter(([m]) => m === "apply").map(([, , p]) => p));

test("a Pi chat reaches the hub (the control); a Claude Agent chat cannot be shared and is not in the shared list", async () => {
	const r = rig();
	seen.length = 0;
	r.tap("pi:started", started("chat-1"));
	assert.ok(seen.some(([m]) => m === "apply"), "a Pi event reaches the hub");
	// (Sharing a Pi chat would switch Remote on and start a real server: not done here. A Claude chat is refused before any of that.)
	const refused = await r.handlers.get("remote:share")({}, "chat-2", true);
	assert.deepStrictEqual(refused, { error: "Unknown chat" });
	const status = await r.handlers.get("remote:status")({});
	assert.ok(!status.shared.includes("chat-2"), "not in the shared list");
});

test("nothing about a Claude Agent chat reaches the hub: start, setup state, records, cost, status, exit", () => {
	const r = rig();
	seen.length = 0;
	const claude = [
		["pi:started", started("chat-2", { agent: { id: "claude" }, needsSetup: true })],
		["pi:ready", { chatId: "chat-2", sessionFile: path.join(tmp, "claude.jsonl") }],
		["pi:record", record("chat-2", { type: "agent_start" })],
		["pi:record", record("chat-2", { type: "message_start", message: { role: "user", content: [{ type: "text", text: "secret prompt" }] } })],
		["pi:record", record("chat-2", { type: "extension_ui_request", id: "s1", method: "setStatus", statusKey: "crust-context", statusText: JSON.stringify({ costUsd: 4.2 }) })],
		["pi:record", record("chat-2", { type: "extension_ui_request", id: "s2", method: "setStatus", statusKey: "permission-mode", statusText: "Mode: Trusted" })],
		["pi:record", record("chat-2", { type: "claude_paused", reason: "budget", totalCostUsd: 5.02, limitUsd: 5 })],
		["pi:record", record("chat-2", { type: "agent_end" })],
		["pi:exit", { chatId: "chat-2", code: 0 }],
	];
	for (const [ch, p] of claude) r.tap(ch, p);
	assert.deepStrictEqual(seen.filter((c) => c[1] === "chat-2" || c[2] === "chat-2"), [], "no hub call mentions the Claude chat");
	assert.deepStrictEqual([...hubChats()].filter((c) => c === "chat-2"), []);
	// control: the same events for the Pi chat do reach the hub
	r.tap("pi:started", started("chat-1"));
	r.tap("pi:record", record("chat-1", { type: "agent_start" }));
	assert.ok(seen.some((c) => c[2] === "chat-1"), "the Pi chat's events reach the hub");
});

test("the app's own claude:* channels never feed the hub (key state)", () => {
	const r = rig();
	seen.length = 0;
	r.tap("claude:setup", { key: { state: "done", source: "stored" }, engine: { state: "done" }, ready: true, limitUsd: 5 });
	assert.deepStrictEqual(seen, []);
});

test("the phone cannot reach a Claude Agent chat's controls: messages, abort, answers and restart are all refused", async () => {
	const r = rig();
	// Even if its id were somehow in the share file, it is not an open Pi chat, so the phone's routes find nothing to act on.
	const list = await r.handlers.get("remote:status")({});
	assert.ok(!JSON.stringify(list).includes("chat-2"));
	const before = r.requests.length;
	r.tap("pi:started", started("chat-2", { agent: { id: "claude" } }));
	assert.strictEqual(r.requests.length, before, "no request was made for it");
});
