"use strict";
// Review round after phase 7 (security and spec reviews): what the adapter does with history, errors and the last answer (the key is scrubbed),
// no engine = no query, every mode in the SDK's "default", slash commands the SDK would run itself, and the capability data.
// Stand-in SDK only; no real key, no model.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");
const { createClaudeAdapter, CAPABILITIES, SLASH_ALLOW } = require("../src/agents/claude");

const STAND_IN = path.join(__dirname, "claude-sdk-stand-in.mjs");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "claude-round-"));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const PATTERN_KEY = "sk-ant-test-DUMMYKEY-0123456789";
const PLAIN_KEY = "plainSecretValue-1234567890abcdef"; // not shaped like sk-ant-: only the exact match can remove it

async function rig({ key = PATTERN_KEY, enginePath = () => ({ path: "C:/stub/claude.exe" }), isPackaged = () => false, wrap, mode, askAnswer } = {}) {
	const sdk = await import(pathToFileURL(STAND_IN).href);
	sdk.reset();
	const cwd = fs.mkdtempSync(path.join(tmp, "proj-"));
	const adapter = createClaudeAdapter({
		...(enginePath ? { enginePath } : {}),
		keystore: { read: async () => ({ source: "stored", key }), status: async () => ({ source: "stored" }), set: async () => ({ ok: true }), clear: async () => ({ ok: true }) },
		configDir: path.join(tmp, "cfg"),
		isPackaged,
		loadSdk: async () => (wrap ? wrap(sdk) : sdk),
		killTree: () => {},
		getSettings: () => ({}),
		env: {},
	});
	const events = { ready: [], records: [], exit: [], asked: [] };
	const sink = { isCurrent: () => true, ready: (h, d) => events.ready.push(d), record: (h, r) => events.records.push(r), stderr() {}, exit: (h, i) => events.exit.push(i), ...(askAnswer ? { ask: async (h, prompt, meta) => (events.asked.push({ prompt, meta }), askAnswer) } : {}) };
	const until = async (f, ms = 3000) => {
		const t = Date.now();
		while (!f()) {
			if (Date.now() - t > ms) throw new Error("timed out");
			await new Promise((r) => setTimeout(r, 5));
		}
	};
	let id = 0;
	const ask = async (h, type, extra = {}) => {
		const myId = `q${++id}`;
		adapter.send(h, { id: myId, type, ...extra });
		await until(() => events.records.some((r) => r.type === "response" && r.id === myId));
		return events.records.find((r) => r.type === "response" && r.id === myId);
	};
	const start = async (opts = {}) => {
		const h = adapter.start({ cwd, ...(mode ? { mode } : {}), ...opts }, sink);
		await until(() => events.ready.length >= 1);
		return h;
	};
	return { sdk, adapter, cwd, events, until, ask, start };
}

test("get_messages (the history sent to the renderer) is scrubbed of the exact key and of the sk-ant- pattern", async () => {
	for (const key of [PLAIN_KEY, PATTERN_KEY]) {
		const t = await rig({ key });
		t.sdk.setScript([{ type: "system", subtype: "init", session_id: "s1", model: "claude-haiku-5-5", permissionMode: "default" }]);
		const rows = JSON.parse(fs.readFileSync(path.join(__dirname, "claude-fixtures", "history.json"), "utf8")).messages;
		const dirty = JSON.parse(JSON.stringify(rows).replace('"text":"', `"text":"my key is ${key} and ${key} `));
		assert.ok(JSON.stringify(dirty).includes(key), "the fixture really holds the key");
		t.sdk.setSessionMessages({ s1: dirty });
		const h = await t.start();
		t.adapter.send(h, { type: "prompt", message: "hi" });
		await t.until(() => t.events.records.some((r) => r.type === "claude_session"));
		const r = await t.ask(h, "get_messages");
		assert.equal(r.success, true);
		assert.ok(!JSON.stringify(r).includes(key), "no key in the history response: " + key.slice(0, 8));
		assert.ok(JSON.stringify(r).includes("[key]"));
		t.adapter.stop(h);
	}
});

test("lastAssistantText is stored scrubbed; a failing request's error is scrubbed with the exact key too", async () => {
	const t = await rig({ key: PLAIN_KEY, wrap: (s) => ({ ...s, getSessionMessages: async () => { throw new Error("disk said " + PLAIN_KEY); } }) });
	// a real captured answer whose text mentions the key
	t.sdk.setScript(JSON.parse(JSON.stringify(t.sdk.fixtureScript(path.join(__dirname, "claude-fixtures", "read.jsonl"))).replace(/shopping list/g, PLAIN_KEY)));
	const h = await t.start();
	t.adapter.send(h, { type: "prompt", message: "hi" });
	await t.until(() => t.events.records.some((r) => r.type === "agent_settled"));
	assert.ok(h.meta.lastAssistantText && h.meta.lastAssistantText.includes("[key]"), "something was stored");
	assert.ok(!h.meta.lastAssistantText.includes(PLAIN_KEY), "stored scrubbed");
	const last = await t.ask(h, "get_last_assistant_text");
	assert.ok(!JSON.stringify(last).includes(PLAIN_KEY));
	const m = await t.ask(h, "get_messages");
	assert.equal(m.success, false);
	assert.ok(!JSON.stringify(m).includes(PLAIN_KEY), "the error does not carry the exact key");
	assert.match(m.error, /\[key\]/);
	t.adapter.stop(h);
});

test("no verified engine path: no query is built (the SDK would search node_modules folders up the tree)", async () => {
	for (const enginePath of [null, () => ({ path: null, reason: "no" }), () => null, () => ({ path: "" }), () => ({ path: 7 })]) {
		const t = await rig({ enginePath, isPackaged: () => true });
		t.adapter.start({ cwd: t.cwd }, { isCurrent: () => true, ready: (h, d) => t.events.ready.push(d), record() {}, stderr() {}, exit: (h, i) => t.events.exit.push(i) });
		await t.until(() => t.events.exit.length === 1);
		assert.equal(t.sdk.calls.length, 0, "the SDK was never asked for a query");
		assert.equal(t.events.exit[0].kind, "error");
		assert.match(t.events.exit[0].error, /engine is not installed/);
	}
	// and with the engine's path it passes it on
	const ok = await rig();
	const h = await ok.start();
	assert.equal(ok.sdk.calls[0].options.pathToClaudeCodeExecutable, "C:/stub/claude.exe");
	ok.adapter.stop(h);
});

test("every chat mode runs the SDK in default, at start and after every switch; no skip flag is ever passed", async () => {
	for (const mode of ["plan", "ask-edits", "ask-commands", "trusted"]) {
		const t = await rig({ mode });
		const h = await t.start();
		const o = t.sdk.calls[0].options;
		assert.equal(o.permissionMode, "default", mode);
		assert.ok(!("allowDangerouslySkipPermissions" in o), mode);
		for (const next of ["plan", "ask-edits", "ask-commands", "trusted"]) {
			const r = await t.ask(h, "prompt", { message: `/crust-mode ${next}` });
			assert.equal(r.success, true);
		}
		assert.ok(t.sdk.calls[0].modes.length >= 4 && t.sdk.calls[0].modes.every((m) => m === "default"), "the SDK was told: " + t.sdk.calls[0].modes.join(","));
		t.adapter.stop(h);
	}
	assert.ok(!/bypassPermissions|allowDangerouslySkipPermissions/.test(fs.readFileSync(path.join(__dirname, "..", "src", "agents", "claude", "index.js"), "utf8").replace(/\/\/.*$/gm, "")), "the adapter never names the skipping mode");
});

test("a message that starts with / is forwarded only for the short allow list; every other command is answered locally", async () => {
	assert.deepEqual([...SLASH_ALLOW], ["context", "usage", "recap", "skill-doctor"]);
	for (const never of ["add-dir", "plugin", "mcp", "hooks", "permissions", "config", "login"]) assert.ok(!SLASH_ALLOW.includes(never), never);
	const t = await rig();
	const h = await t.start();
	const sent = () => h.turns.length; // one turn per prompt the adapter forwarded
	for (const msg of ["/add-dir C:/", "/plugin install x", "/mcp", "/hooks", "/permissions", "/config a=b", "/login", "  /add-dir x", "\n/mcp", "\u200b/hooks", "/unknown", "/Context", "/add-dir"]) {
		const before = sent();
		const r = await t.ask(h, "prompt", { message: msg });
		assert.equal(r.success, false, msg);
		assert.match(r.error, /not available in Claude Agent chats/, msg);
		assert.equal(sent(), before, "nothing was forwarded: " + JSON.stringify(msg));
	}
	assert.ok(!t.events.records.some((r) => r.type === "message_start" && r.message && r.message.role === "user"), "no user row either");
	for (const msg of ["/context", "/usage now", "  /recap", "/skill-doctor", "hello /add-dir", "what does /mcp do"]) {
		const before = sent();
		const r = await t.ask(h, "prompt", { message: msg });
		assert.equal(r.success, true, msg);
		assert.equal(sent(), before + 1, "forwarded: " + msg);
	}
	t.adapter.stop(h);
});

test("the capability data says what the code does: Agent calls render as subagent cards", async () => {
	assert.equal(CAPABILITIES.subagentCards, true);
	const t = await rig();
	t.sdk.setScript([
		{ type: "system", subtype: "init", session_id: "s1", model: "claude-haiku-5-5", permissionMode: "default" },
		{ type: "stream_event", event: { type: "message_start" } },
		{ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: "Agent", input: {} } } },
		{ type: "stream_event", event: { type: "content_block_stop", index: 0 } },
		{ type: "stream_event", event: { type: "message_stop" } },
		{ type: "system", subtype: "task_started", task_id: "k1", tool_use_id: "t1", description: "d" },
		{ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "done" }] }, tool_use_result: { status: "async_launched" } },
	]);
	const h = await t.start();
	t.adapter.send(h, { type: "prompt", message: "hi" });
	await t.until(() => t.events.records.some((r) => r.toolName === "subagent"));
	t.adapter.stop(h);
});

// --- review round 2: ordinary text that starts with a slash, and the key in what the sink is given -----------------------------------------
test("a message is a command only when its first token is / and a name of letters, digits and dashes; other text that starts with / is ordinary", async () => {
	const t = await rig();
	const h = await t.start();
	const sent = () => h.turns.length;
	for (const msg of ["/src/a.js broken", "/a.b", "/tmp/x", "/etc/hosts is odd", "/ hello", "/add-dir/x", "/add-dir.x", "//mcp", "/.hidden file", "  /src/app.js fails", "/foo:bar/baz", "/foo_bar.js broke", "/foo:bar.x"]) {
		const before = sent();
		const r = await t.ask(h, "prompt", { message: msg });
		assert.equal(r.success, true, msg);
		assert.equal(sent(), before + 1, "forwarded as text: " + JSON.stringify(msg));
	}
	for (const msg of ["/add-dir C:/", "/mcp", "/hooks", "  /config a=b", "/login", "/unknown", "/some-name-1 x", "/foo:bar", "/foo_bar x", "/plugin:cmd arg", "/mcp__srv__prompt x", "  /Foo:Bar_1-x"]) {
		const r = await t.ask(h, "prompt", { message: msg });
		assert.equal(r.success, false, "still a command: " + msg);
		assert.match(r.error, /not available in Claude Agent chats/, msg);
	}
	t.adapter.stop(h);
});

test("the sink's ready payload is scrubbed of the key too", async () => {
	for (const key of [PLAIN_KEY, PATTERN_KEY]) {
		const leak = (sdk) => ({
			...sdk,
			query: (q) => {
				const g = sdk.query(q);
				const orig = g.initializationResult;
				g.initializationResult = async () => ({ ...(await orig()), account: { note: "token " + key }, commands: [{ name: "x", description: "uses " + key }] });
				return g;
			},
		});
		const t = await rig({ key, wrap: leak });
		const h = await t.start();
		assert.ok(JSON.stringify(t.events.ready).includes("[key]"), "the payload is there, scrubbed");
		assert.ok(!JSON.stringify(t.events.ready).includes(key), "no key in the ready payload: " + key.slice(0, 8));
		t.adapter.stop(h);
	}
});

test("a command that holds the key is shown to the sink's ask with the key scrubbed, and the answer decides", async () => {
	for (const answer of ["Allow once", "Deny"]) {
		const t = await rig({ mode: "ask-commands", askAnswer: answer });
		const call = { __tool_call: { tool_name: "Bash", tool_input: { command: "curl -H x-api-key:" + PATTERN_KEY + " https://example.com/x && npm run build" } } };
		t.sdk.setScript([{ type: "system", subtype: "init", session_id: "s1" }, call, { type: "result", subtype: "success", is_error: false, result: "ok", total_cost_usd: 0, session_id: "s1" }]);
		const h = await t.start();
		t.adapter.send(h, { type: "prompt", message: "go" });
		await t.until(() => t.sdk.calls[0].gates.length >= 1 && t.sdk.calls[0].gates[0].outcome);
		assert.equal(t.events.asked.length, 1, "the gate asked the sink once");
		const shown = JSON.stringify(t.events.asked[0].prompt);
		assert.ok(!shown.includes(PATTERN_KEY) && shown.includes("[key]"), "the prompt text is scrubbed");
		assert.deepEqual(t.events.asked[0].prompt.options.slice(-1), ["Deny"]);
		assert.equal(t.sdk.calls[0].gates[0].outcome, answer === "Deny" ? "deny" : "allow");
		t.adapter.stop(h);
	}
});
