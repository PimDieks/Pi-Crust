"use strict";
// Claude agent, phase 7 T8: records through the adapter, the requests it answers, history and status. Everything runs against the
// stand-in SDK (scripts/claude-sdk-stand-in.mjs): no Electron, no real SDK, no key, no model.
// Negative controls: CLAUDE_FLOW_BREAK=<replay|interrupt|requests|history|status> breaks one thing on purpose; that group must go red.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");
const { createClaudeAdapter } = require("../src/agents/claude");
const { REQUEST_TYPES } = require("../src/agents/adapter");
const { UNSUPPORTED } = require("../src/agents/claude/requests");
const { convertMessages } = require("../src/agents/claude/history");
const { contextStatus, pauseEvent, newTrack, trackUsage } = require("../src/agents/claude/status");

const lines = (f) => fs.readFileSync(f, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
const READ_SESSION = lines(path.join(__dirname, "claude-fixtures", "read.jsonl"))[0].session_id;
const BREAK = process.env.CLAUDE_FLOW_BREAK || "";
const KEY = "sk-ant-test-DUMMYKEY-0123456789";
const DIR = path.join(__dirname, "claude-fixtures");
const STAND_IN = path.join(__dirname, "claude-sdk-stand-in.mjs");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "claude-flow-"));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const clock = () => {
	let t = 1000;
	return () => (t += 7);
};
const golden = (n) => lines(path.join(DIR, `${n}.golden.jsonl`));
const types = (r) => r.map((x) => x.type);
const HISTORY = JSON.parse(fs.readFileSync(path.join(DIR, "history.json"), "utf8"));
// Records the translator goldens know; the adapter adds statuses, responses and the pause event around them.
// The user row carries the uuid the adapter gave the message (random); the goldens do not have it. claude-rewind-fork.test.js checks it.
const noUuid = (r) => (r.message && r.message.uuid ? { ...r, message: Object.fromEntries(Object.entries(r.message).filter(([k]) => k !== "uuid")) } : r);
const isPi = (r) => !["extension_ui_request", "response", "claude_paused"].includes(r.type);

async function rig({ configDir = path.join(tmp, "cfg"), settings = {}, breakSdk } = {}) {
	const sdk = await import(pathToFileURL(STAND_IN).href);
	sdk.reset();
	const cwd = fs.mkdtempSync(path.join(tmp, "proj-"));
	let loaded = sdk;
	if (breakSdk) loaded = breakSdk(sdk);
	const adapter = createClaudeAdapter({ enginePath: () => ({ path: "C:/stub/claude.exe" }),
		keystore: { read: async () => ({ source: "stored", key: KEY }), status: async () => ({ source: "stored" }), set: async () => ({ ok: true }), clear: async () => ({ ok: true }) },
		configDir,
		isPackaged: () => false,
		loadSdk: async () => loaded,
		killTree: () => {},
		getSettings: () => settings,
		env: {},
		now: clock(),
	});
	const events = { ready: [], records: [], exit: [] };
	const sink = { isCurrent: () => true, ready: (h, d) => events.ready.push(d), record: (h, r) => events.records.push(r), stderr: () => {}, exit: (h, i) => events.exit.push(i) };
	const until = async (f, ms = 3000) => {
		const t = Date.now();
		while (!f()) {
			if (Date.now() - t > ms) throw new Error("timed out");
			await new Promise((r) => setTimeout(r, 5));
		}
	};
	if (configDir === null) return { sdk, adapter, cwd, events, stop: () => {} }; // nothing starts without the app's config folder
	const h = adapter.start({ cwd }, sink);
	await until(() => events.ready.length === 1);
	let id = 0;
	// One request and its answer.
	const ask = async (type, extra = {}) => {
		const myId = `r${++id}`;
		adapter.send(h, { id: myId, type, ...extra });
		await until(() => events.records.some((r) => r.type === "response" && r.id === myId));
		return events.records.find((r) => r.type === "response" && r.id === myId);
	};
	return { sdk, adapter, cwd, h, events, until, ask, configDir, stop: () => adapter.stop(h), settled: (n) => events.records.filter((r) => r.type === "agent_settled").length >= n };
}

// --- records ----------------------------------------------------------------------------------------------------------------

const REPLAYS = ["read", "edit-allow", "edit-deny", "thinking-subagent", "subagent-background", "interrupt"];
for (const name of REPLAYS) {
	test(`replay ${name}: the fixture through the adapter gives the translator's golden records`, async () => {
		const t = await rig();
		t.sdk.setFixture(path.join(DIR, `${name}.jsonl`));
		const want = golden(name);
		const prompt = want[1].message.content[0].text; // the first row is agent_start, the second the user row of the prompt
		assert.ok(t.adapter.send(t.h, { type: "prompt", message: prompt }));
		const turns = want.filter((r) => r.type === "agent_settled").length;
		await t.until(() => t.settled(turns));
		await t.until(() => t.events.records.some((r) => r.type === "extension_ui_request"));
		let got = t.events.records.filter(isPi).map(noUuid);
		if (BREAK === "replay") got = got.filter((r) => r.type !== "tool_execution_end" || r.toolName === "subagent");
		assert.equal(got.length, want.length, `record count (${types(got).join(",")})`);
		got.forEach((r, i) => assert.deepEqual(r, want[i], `record ${i} (${r.type})`));
		t.stop();
	});
}

test("replay: no raw SDK message and no claude_budget_reached reaches the sink any more", async () => {
	const t = await rig();
	t.sdk.setFixture(path.join(DIR, "read.jsonl"));
	t.adapter.send(t.h, { type: "prompt", message: "x" });
	await t.until(() => t.settled(1));
	assert.ok(!t.events.records.some((r) => r.type === "sdk_message" || r.type === "claude_budget_reached"));
	t.stop();
});

test("interrupt, then a second prompt in the same open session", async () => {
	const t = await rig({ breakSdk: BREAK === "interrupt" ? (sdk) => ({ ...sdk, query: (q) => Object.assign(sdk.query(q), { interrupt: async () => {} }) }) : undefined });
	t.sdk.setFixture(path.join(DIR, "interrupt-continue.jsonl"), { awaitUser: [19] });
	const want = golden("interrupt-continue");
	t.adapter.send(t.h, { type: "prompt", message: "Count from 1 to 200." });
	await t.until(() => t.settled(1));
	const resp = await t.ask("abort");
	assert.equal(resp.success, true);
	assert.equal(t.sdk.calls[0].interrupted, 1, "interrupt() was called once");
	assert.equal(t.sdk.calls[0].closed, false, "the session stays open");
	assert.ok(t.adapter.canSend(t.h), "the input is still open");
	assert.ok(t.adapter.send(t.h, { type: "prompt", message: "Reply with the single word: ready." }));
	await t.until(() => t.settled(2));
	const got = t.events.records.filter(isPi).map(noUuid);
	assert.equal(got.length, want.length);
	got.forEach((r, i) => assert.deepEqual(r, want[i], `record ${i} (${r.type})`));
	assert.deepEqual(got.filter((r) => r.type === "agent_settled"), [{ type: "agent_settled", aborted: true }, { type: "agent_settled" }]);
	assert.equal(t.sdk.calls[0].calls.filter((c) => c === "user_message").length, 2);
	t.stop();
});

// --- requests ---------------------------------------------------------------------------------------------------------------

test("get_state, get_available_models, set_model", async () => {
	const t = await rig({ breakSdk: BREAK === "requests" ? (sdk) => ({ ...sdk, query: (q) => Object.assign(sdk.query(q), { setModel: async () => {} }) }) : undefined });
	t.sdk.setFixture(path.join(DIR, "read.jsonl"));
	t.adapter.send(t.h, { type: "prompt", message: "go" });
	await t.until(() => t.settled(1));
	const models = await t.ask("get_available_models");
	assert.deepEqual(models.data.models.map((m) => m.id), ["default", "sonnet", "haiku"], "the list comes from supportedModels()");
	assert.equal(models.data.models[1].provider, "anthropic");
	assert.equal(models.data.models[1].name, "Sonnet");
	assert.ok(t.sdk.calls[0].log.some((l) => l.fn === "supportedModels"));
	const st = await t.ask("get_state");
	assert.equal(st.success, true);
	assert.ok(st.data.sessionFile, "the session id is the session ref");
	assert.equal(st.data.model.id, "haiku", "the engine's model claude-haiku-5-5 maps to its alias");
	assert.equal(st.data.isStreaming, false);
	const set = await t.ask("set_model", { provider: "anthropic", modelId: "sonnet" });
	assert.equal(set.success, true);
	assert.deepEqual(t.sdk.calls[0].log.filter((l) => l.fn === "setModel").map((l) => l.args), [["sonnet"]]);
	assert.equal((await t.ask("get_state")).data.model.id, "sonnet");
	const bad = await t.ask("set_model", { provider: "anthropic", modelId: "gpt-9" });
	assert.equal(bad.success, false);
	assert.ok(!bad.unsupported && bad.error);
	assert.equal(t.sdk.calls[0].log.filter((l) => l.fn === "setModel").length, 1, "an unknown model never reaches the SDK");
	t.stop();
});

test("effort levels: the model's own list, no off; set_thinking_level goes through applyFlagSettings", async () => {
	const t = await rig();
	t.sdk.setFixture(path.join(DIR, "read.jsonl"));
	t.adapter.send(t.h, { type: "prompt", message: "go" });
	await t.until(() => t.settled(1));
	assert.deepEqual((await t.ask("get_available_thinking_levels")).data.levels, [], "haiku has no effort levels: the control hides");
	await t.ask("set_model", { provider: "anthropic", modelId: "sonnet" });
	const lv = await t.ask("get_available_thinking_levels");
	assert.deepEqual(lv.data.levels, ["low", "medium", "high", "xhigh", "max"]);
	assert.ok(!lv.data.levels.includes("off"));
	const ok = await t.ask("set_thinking_level", { level: "high" });
	assert.equal(ok.success, true);
	assert.deepEqual(t.sdk.calls[0].log.filter((l) => l.fn === "applyFlagSettings").map((l) => l.args), [[{ effortLevel: "high" }]]);
	assert.equal((await t.ask("get_state")).data.thinkingLevel, "high");
	const off = await t.ask("set_thinking_level", { level: "off" });
	assert.equal(off.success, false);
	assert.equal(t.sdk.calls[0].log.filter((l) => l.fn === "applyFlagSettings").length, 1, "off never reaches the SDK");
	t.stop();
});

test("get_commands, get_last_assistant_text, get_messages (through the SDK, in the stored shape)", async () => {
	const t = await rig();
	t.sdk.setSessionMessages({ [READ_SESSION]: HISTORY.messages });
	t.sdk.setFixture(path.join(DIR, "read.jsonl"));
	t.adapter.send(t.h, { type: "prompt", message: "go" });
	await t.until(() => t.settled(1));
	assert.deepEqual((await t.ask("get_commands")).data.commands[0], { name: "compact", description: "Compact the conversation", source: "claude" });
	assert.match((await t.ask("get_last_assistant_text")).data.text, /shopping list/i);
	const m = await t.ask("get_messages");
	assert.equal(m.success, true);
	assert.deepEqual(m.data.messages.map((x) => x.role), ["user", "assistant", "toolResult", "assistant"]);
	const call = t.sdk.fnCalls.find((c) => c.fn === "getSessionMessages");
	assert.equal(call.args[0], READ_SESSION, "the session id of the chat");
	assert.equal(call.CLAUDE_CONFIG_DIR, t.configDir, "read under the app's own config folder");
	t.stop();
});

test("every request type the app sends gets an answer; what Claude cannot serve says so and why", async () => {
	const t = await rig();
	const served = new Set(["get_state", "get_available_models", "set_model", "get_available_thinking_levels", "set_thinking_level", "abort", "get_messages", "get_commands", "get_last_assistant_text", "get_fork_messages", "fork"]);
	for (const type of REQUEST_TYPES) {
		if (type === "prompt" || type === "extension_ui_response") continue; // the adapter's own; the gate's (no response record in the contract)
		const extra = type === "set_model" ? { modelId: "sonnet" } : type === "set_thinking_level" ? { level: "low" } : {};
		const r = await t.ask(type, extra);
		if (served.has(type)) assert.notEqual(r.unsupported, true, `${type} is served`);
		else {
			assert.equal(r.success, false, type);
			assert.equal(r.unsupported, true, type);
			assert.ok(typeof r.error === "string" && r.error.length > 10, `${type} says why`);
			assert.equal(r.error, UNSUPPORTED[type]);
		}
		assert.equal(r.command, type);
	}
	for (const k of Object.keys(UNSUPPORTED)) assert.ok(REQUEST_TYPES.includes(k), `${k} is a real request type`);
	const unknown = await t.ask("teleport");
	assert.equal(unknown.unsupported, true);
	t.stop();
});

// --- status: context, cost, pause -------------------------------------------------------------------------------------------

test("after each result: the crust-context status (window, categories, models, cost) and no cost estimate presented as exact", async () => {
	const t = await rig({ settings: { claudeMaxBudgetUsd: 2.5 }, breakSdk: BREAK === "status" ? (sdk) => ({ ...sdk, query: (q) => Object.assign(sdk.query(q), { getContextUsage: async () => ({}) }) }) : undefined });
	t.sdk.setFixture(path.join(DIR, "read.jsonl"));
	t.adapter.send(t.h, { type: "prompt", message: "go" });
	await t.until(() => t.settled(1));
	const isCtx = (r) => r.type === "extension_ui_request" && r.statusKey === "crust-context"; // the permission-mode status comes first now
	await t.until(() => t.events.records.some(isCtx));
	const rec = t.events.records.find(isCtx);
	assert.equal(rec.method, "setStatus");
	assert.equal(rec.statusKey, "crust-context");
	const d = JSON.parse(rec.statusText);
	assert.equal(d.window, 1000000);
	assert.equal(d.total, 3374);
	assert.deepEqual(d.categories, { messages: 886, tools: 2488, skills: 0, system: 0, memory: 0, reserve: 33000 });
	assert.equal(d.model, "anthropic/claude-haiku-5-5");
	assert.ok(d.costUsd > 0 && d.turnCostUsd > 0 && d.costEstimate === true);
	assert.equal(d.models[0].model, "claude-haiku-5-5");
	assert.equal(d.models[0].turns, 1);
	const end = t.events.records.find((r) => r.type === "agent_end");
	assert.equal(d.costUsd, end.totalCostUsd);
	assert.ok(t.sdk.calls[0].log.some((l) => l.fn === "getContextUsage"));
	t.stop();
});

test("status.js: categories by kind, unknown used ids count as system, free space is not counted", () => {
	const d = contextStatus({ categories: [{ id: "custom_x", tokens: 5, kind: "used" }, { id: "skills", tokens: 7, kind: "used" }, { id: "free_space", tokens: 99, kind: "free" }, { id: "autocompact_buffer", tokens: 3, kind: "buffer" }], totalTokens: 15, rawMaxTokens: 100, percentage: 15, model: "m" }, newTrack());
	assert.deepEqual(d.categories, { messages: 0, tools: 0, skills: 7, system: 5, memory: 0, reserve: 3 });
	assert.equal(contextStatus(null), null);
	const tr = trackUsage(newTrack(), { total_cost_usd: 0.5, modelUsage: { a: { inputTokens: 1, outputTokens: 2, costUSD: 0.5 } }, model_usage_since_last_result: { a: { costUSD: 0.2 } } });
	assert.equal(tr.turnCostUsd, 0.2);
	assert.equal(tr.totalCostUsd, 0.5);
});

test("the budget stop is the pause event, with what the UI needs to offer Continue", async () => {
	const t = await rig({ settings: { claudeMaxBudgetUsd: 2.5 } });
	t.sdk.setScript([{ type: "system", subtype: "init", session_id: "s1", model: "claude-haiku-5-5", permissionMode: "default" }, { type: "result", subtype: "error_max_budget_usd", is_error: true, total_cost_usd: 2.51, session_id: "s1" }]);
	t.adapter.send(t.h, { type: "prompt", message: "go" });
	await t.until(() => t.events.records.some((r) => r.type === "claude_paused"));
	const p = t.events.records.find((r) => r.type === "claude_paused");
	assert.deepEqual(p, { type: "claude_paused", reason: "budget", message: "Stopped: the spending limit ($2.50) was reached. About $2.51 spent.", totalCostUsd: 2.51, limitUsd: 2.5, maxTurns: 100, sessionId: "s1", canContinue: true, continueLabel: "Continue" });
	assert.ok(t.events.records.some((r) => r.type === "agent_settled"), "the turn still ends");
	assert.equal(pauseEvent({ type: "result", subtype: "success" }), null);
	assert.equal(pauseEvent({ type: "result", subtype: "error_max_turns", session_id: "s" }, { maxTurns: 3 }).reason, "turns");
	t.stop();
});

// --- history ----------------------------------------------------------------------------------------------------------------

test("convertMessages: a recorded session becomes stored messages (user, assistant with toolCall, toolResult, assistant)", () => {
	let rows = HISTORY.messages;
	if (BREAK === "history") rows = rows.filter((r) => !(r.type === "user" && Array.isArray(r.message.content)));
	const msgs = convertMessages(rows);
	assert.deepEqual(msgs.map((m) => m.role), ["user", "assistant", "toolResult", "assistant"]);
	assert.deepEqual(msgs[0].content, [{ type: "text", text: "Read the file notes.txt and tell me in one sentence what it says." }]);
	const call = msgs[1].content[0];
	assert.equal(call.type, "toolCall");
	assert.equal(call.name, "read");
	assert.equal(call.arguments.path, "C:\\work\\proj\\notes.txt");
	assert.equal(msgs[1].stopReason, "toolUse");
	assert.equal(msgs[2].toolCallId, call.id);
	assert.equal(msgs[2].toolName, "read");
	assert.equal(msgs[2].isError, false);
	assert.equal(msgs[3].stopReason, "stop");
	assert.equal(msgs[3].content[0].type, "text");
});

test("convertMessages: per-block rows of one API message merge, the interrupt marker is not a user row, a subagent's messages ride on its card, images keep their data", () => {
	const row = (type, message, extra = {}) => ({ type, message, parent_tool_use_id: null, timestamp: "2026-11-18T13:37:02.530Z", ...extra });
	const msgs = convertMessages([
		row("user", { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }, { type: "text", text: "look" }] }),
		row("assistant", { id: "m1", content: [{ type: "thinking", thinking: "" }], stop_reason: null }),
		row("assistant", { id: "m1", content: [{ type: "tool_use", id: "t1", name: "Agent", input: { subagent_type: "checker", description: "count" } }], stop_reason: "tool_use" }),
		row("user", { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "launched" }] }),
		row("assistant", { id: "i1", content: [{ type: "text", text: "inner" }] }, { parent_tool_use_id: "t1" }),
		row("user", { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] }),
	]);
	assert.deepEqual(msgs.map((m) => m.role), ["user", "assistant", "toolResult"]);
	assert.deepEqual(msgs[0].content[0], { type: "image", data: "AAAA", mimeType: "image/png" });
	assert.equal(msgs[0].timestamp, Date.parse("2026-11-18T13:37:02.530Z"));
	assert.equal(msgs[1].content.length, 1, "the empty thinking block is dropped, the tool call stays");
	assert.equal(msgs[2].toolName, "subagent");
	assert.equal(msgs[2].details.results[0].agent, "checker");
	assert.equal(msgs[2].details.results[0].messages[0].content[0].text, "inner");
});

test("listSessions goes through the SDK under the app's config folder, in the picker's shape; a missing folder reads nothing", async () => {
	const t = await rig();
	t.sdk.setSessions(HISTORY.sessions);
	const before = process.env.CLAUDE_CONFIG_DIR;
	const list = await t.adapter.listSessions({ cwd: t.cwd });
	assert.equal(process.env.CLAUDE_CONFIG_DIR, before, "the environment is restored");
	assert.equal(t.sdk.fnCalls.length, 1);
	assert.equal(t.sdk.fnCalls[0].fn, "listSessions");
	assert.deepEqual(t.sdk.fnCalls[0].args[0].dir, t.cwd);
	assert.equal(t.sdk.fnCalls[0].CLAUDE_CONFIG_DIR, t.configDir);
	assert.equal(list.length, HISTORY.sessions.length);
	assert.deepEqual(Object.keys(list[0]).sort(), ["agent", "branch", "cwd", "firstPrompt", "mtime", "name", "path", "size"]);
	assert.equal(list[0].agent, "claude");
	assert.ok(list.every((s, i) => i === 0 || list[i - 1].mtime >= s.mtime), "newest first");
	t.stop();
	const t2 = await rig({ configDir: null });
	assert.deepEqual(await t2.adapter.listSessions({ cwd: t2.cwd }), []);
	assert.equal(t2.sdk.fnCalls.length, 0, "no config folder: the user's own Claude sessions are never read");
});

test("resume passes the session id to the SDK", async () => {
	const t = await rig();
	t.stop();
	const sdk = t.sdk;
	sdk.reset();
	const h = t.adapter.start({ cwd: t.cwd, sessionRef: "session-1" }, { isCurrent: () => true, ready: () => {}, record: () => {}, stderr: () => {}, exit: () => {} });
	await t.until(() => sdk.calls.length === 1);
	assert.equal(sdk.calls[0].options.resume, "session-1");
	t.adapter.stop(h);
});

test("negative control: without its task_notification the background card never ends, and the golden comparison notices", () => {
	const { createTranslator } = require("../src/agents/claude/translate");
	const run = (msgs) => {
		const tr = createTranslator({ now: clock() });
		return msgs.flatMap((m, i) => (i === 0 ? [...tr.userMessage({ text: "x" }), ...tr.push(m)] : tr.push(m)));
	};
	const msgs = lines(path.join(DIR, "subagent-background.jsonl"));
	const ends = (o) => o.filter((r) => r.type === "tool_execution_end" && r.toolName === "subagent").length;
	assert.equal(ends(run(msgs)), 1);
	assert.equal(ends(run(msgs.filter((m) => m.subtype !== "task_notification"))), 0);
});

test("history: the SDK is loaded before CLAUDE_CONFIG_DIR is set, the variable is set only around the call, calls do not overlap, a spawn in between sees nothing", async () => {
	const { createHistory } = require("../src/agents/claude/history");
	const env = {};
	const seen = []; // what a child spawned at each point would inherit
	const spawn = (label) => seen.push([label, env.CLAUDE_CONFIG_DIR]);
	let active = 0;
	let maxActive = 0;
	const sdk = {
		listSessions: async () => {
			active++;
			maxActive = Math.max(maxActive, active);
			spawn("inside-call");
			await new Promise((r) => setTimeout(r, 15));
			active--;
			return [];
		},
	};
	const h = createHistory({
		env,
		configDir: () => "C:\\app\\claude",
		loadSdk: async () => {
			spawn("during-load");
			await new Promise((r) => setTimeout(r, 15));
			spawn("end-of-load");
			return sdk;
		},
	});
	const a = h.listSessions({ cwd: "x" });
	const b = h.listSessions({ cwd: "y" });
	await Promise.all([a, b]);
	spawn("after");
	assert.equal(maxActive, 1, "one SDK call at a time");
	for (const [label, v] of seen) {
		if (label === "inside-call") assert.equal(v, "C:\\app\\claude", label);
		else assert.equal(v, undefined, `${label}: a child spawned now must not inherit it`);
	}
	assert.equal(seen.filter(([l]) => l === "inside-call").length, 2);
	assert.ok(!("CLAUDE_CONFIG_DIR" in env), "restored");
});

test("history: listSessions says why it failed (scrubbed) instead of returning an empty list; the merged list keeps the reason per agent", async () => {
	const t = await rig({ breakSdk: (s) => ({ ...s, listSessions: async () => { throw new Error("disk trouble " + KEY); } }) });
	await assert.rejects(t.adapter.listSessions({ cwd: t.cwd }), (e) => /could not be listed: disk trouble/.test(e.message) && !e.message.includes(KEY));
	const { listAllSessions } = require("../src/chat-agents");
	const got = await listAllSessions({ adapters: [{ id: "claude", listSessions: (o) => t.adapter.listSessions(o) }], repo: t.cwd });
	assert.equal(got.status.claude.ok, false);
	assert.match(got.status.claude.reason, /disk trouble/);
	t.stop();
});

test("contextStatus: skillCount comes from the init skills the adapter recorded", () => {
	const track = newTrack();
	track.skillCount = 4;
	assert.equal(contextStatus({ categories: [], totalTokens: 1, maxTokens: 10 }, track).skillCount, 4);
	assert.equal(contextStatus({ categories: [], totalTokens: 1, maxTokens: 10 }).skillCount, 0);
});
