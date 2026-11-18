"use strict";
// Claude adapter shell (phase 7, T4), against the stand-in SDK (scripts/claude-sdk-stand-in.mjs). No Electron, no real SDK, no real key.
// CLAUDE_ADAPTER_BREAK=1 puts the key into a second option (the negative control: the key tests must fail).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");
const { createClaudeAdapter, CLAUDE_MD_CAP_BYTES, NO_KEY } = require("../src/agents/claude");
const { createRegistry } = require("../src/agents/registry");

const KEY = "sk-ant-test-DUMMYKEY-0123456789";
const STAND_IN = path.join(__dirname, "claude-sdk-stand-in.mjs");
const standIn = () => import(pathToFileURL(STAND_IN).href);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "claude-adapter-"));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const keystore = (key = KEY) => ({
	read: async () => (key ? { source: "stored", key } : { source: "none", key: null }),
	status: async () => (key ? { source: "stored" } : { source: "none" }),
	set: async () => ({ ok: true }),
	clear: async () => ({ ok: true }),
});

async function rig({ key = KEY, killTree, loadSdk, projectFiles = {}, settings = {}, env = {} } = {}) {
	const sdk = await standIn();
	sdk.reset();
	const cwd = fs.mkdtempSync(path.join(tmp, "proj-"));
	for (const [f, t] of Object.entries(projectFiles)) fs.writeFileSync(path.join(cwd, f), t);
	const kills = [];
	let realLoad = loadSdk || (async () => sdk);
	if (process.env.CLAUDE_ADAPTER_BREAK) {
		const inner = realLoad;
		realLoad = async (...a) => {
			const m = await inner(...a);
			return { ...m, query: (q) => m.query({ ...q, options: { ...q.options, leak: q.options.env.ANTHROPIC_API_KEY } }) };
		};
	}
	const adapter = createClaudeAdapter({ keystore: keystore(key), configDir: path.join(tmp, "claude-config"), isPackaged: () => false, loadSdk: realLoad, killTree: killTree || ((p, f) => kills.push([p, f])), getSettings: () => settings, env });
	const events = { ready: [], records: [], exit: [], stderr: [] };
	const sink = { isCurrent: () => true, ready: (h, d) => events.ready.push(d), record: (h, r) => events.records.push(r), stderr: (h, t) => events.stderr.push(t), exit: (h, i) => events.exit.push(i) };
	const until = async (f, ms = 3000) => {
		const t = Date.now();
		while (!f()) {
			if (Date.now() - t > ms) throw new Error("timed out");
			await new Promise((r) => setTimeout(r, 5));
		}
	};
	return { sdk, adapter, cwd, kills, events, sink, until };
}

test("the adapter satisfies the contract and registers next to Pi; Pi stays the default", () => {
	const r = createRegistry();
	r.register(require("../src/agents/pi"));
	r.register(require("../src/agents/claude"));
	assert.deepStrictEqual(r.ids(), ["pi", "claude"]);
	assert.strictEqual(r.get().id, "pi");
	assert.strictEqual(r.get("claude").label, "Claude Agent");
	assert.strictEqual(r.get("claude").capabilities.advisor, false);
	assert.strictEqual(r.get("pi").capabilities.advisor, true);
});

test("start: the key reaches the SDK only through env; the other options are as chosen", async () => {
	const t = await rig({ env: { ANTHROPIC_AUTH_TOKEN: "t", CLAUDE_CODE_OAUTH_TOKEN: "o", PATH: "p" } });
	const h0 = t.adapter.start({ cwd: t.cwd, env: { PATH: "p", ANTHROPIC_AUTH_TOKEN: "t", CLAUDE_CODE_OAUTH_TOKEN: "o" }, mode: "ask-edits" }, t.sink);
	await t.until(() => t.events.ready.length === 1);
	const c = t.sdk.calls[0];
	assert.strictEqual(c.rawEnvHasKey, true);
	assert.deepStrictEqual(Object.keys(c.options).filter((k) => JSON.stringify(c.options[k]).includes(KEY)), []);
	assert.ok(!JSON.stringify(c.options).includes(KEY));
	assert.ok(!c.options.env.names.includes("ANTHROPIC_AUTH_TOKEN") && !c.options.env.names.includes("CLAUDE_CODE_OAUTH_TOKEN"));
	assert.ok(c.options.env.names.includes("PATH"));
	assert.strictEqual(c.options.env.CLAUDE_CONFIG_DIR, path.join(tmp, "claude-config"));
	assert.deepStrictEqual(c.options.settingSources, []);
	assert.strictEqual(c.options.includePartialMessages, true);
	assert.strictEqual(c.options.maxBudgetUsd, 5);
	assert.ok(c.options.maxTurns > 0);
	assert.strictEqual(c.options.canUseTool, "[function]");
	assert.strictEqual(c.options.permissionMode, "default");
	assert.deepStrictEqual(c.options.systemPrompt, { type: "preset", preset: "claude_code" });
	t.adapter.stop(h0);
});

test("the budget comes from a setting; a result of error_max_budget_usd is its own event", async () => {
	const t = await rig({ settings: { claudeMaxBudgetUsd: 2.5 } });
	t.sdk.setScript([{ type: "result", subtype: "error_max_budget_usd", is_error: true, total_cost_usd: 2.51, session_id: "s" }]);
	const h = t.adapter.start({ cwd: t.cwd, mode: "plan" }, t.sink);
	await t.until(() => t.events.ready.length === 1);
	assert.strictEqual(t.sdk.calls[0].options.maxBudgetUsd, 2.5);
	assert.strictEqual(t.sdk.calls[0].options.permissionMode, "plan");
	assert.ok(t.adapter.send(h, { type: "prompt", message: "hi" }));
	await t.until(() => t.events.records.some((r) => r.type === "claude_budget_reached"));
	assert.strictEqual(t.events.records.find((r) => r.type === "claude_budget_reached").total_cost_usd, 2.51);
	t.adapter.stop(h);
});

test("no key: a readable error through the sink, and the SDK is never started", async () => {
	const t = await rig({ key: null });
	t.adapter.start({ cwd: t.cwd }, t.sink);
	await t.until(() => t.events.exit.length === 1);
	assert.strictEqual(t.events.exit[0].kind, "error");
	assert.strictEqual(t.events.exit[0].error, NO_KEY);
	assert.strictEqual(t.sdk.calls.length, 0);
	assert.strictEqual(t.events.ready.length, 0);
});

test("the key never shows in an SDK error, in status() or in a failed check", async () => {
	const boom = { query: () => { throw new Error("bad request, x-api-key: " + KEY); } };
	const t = await rig({ loadSdk: async () => boom });
	t.adapter.start({ cwd: t.cwd }, t.sink);
	await t.until(() => t.events.exit.length === 1);
	assert.ok(!JSON.stringify(t.events).includes(KEY));
	assert.match(t.events.exit[0].error, /\[key\]/);
	const st = await t.adapter.auth.status();
	assert.deepStrictEqual(st, { source: "stored" });
	assert.ok(!JSON.stringify(st).includes(KEY));
	const bad = await t.adapter.auth.check(KEY);
	assert.strictEqual(bad.ok, false);
	assert.ok(!JSON.stringify(bad).includes(KEY));
});

test("auth.check makes one tiny request with the key in env only", async () => {
	const t = await rig();
	const r = await t.adapter.auth.check(KEY);
	assert.deepStrictEqual(r, { ok: true });
	assert.strictEqual(t.sdk.calls.length, 1);
	const o = t.sdk.calls[0].options;
	assert.strictEqual(t.sdk.calls[0].rawEnvHasKey, true);
	assert.ok(!JSON.stringify(o).includes(KEY));
	assert.strictEqual(o.maxTurns, 1);
	assert.deepStrictEqual(o.tools, []);
	assert.strictEqual((await t.adapter.auth.check("")).ok, false);
});

test("stop closes the query and tree-kills the child", async () => {
	const t = await rig();
	const h = t.adapter.start({ cwd: t.cwd }, t.sink);
	await t.until(() => t.events.ready.length === 1);
	const child = { pid: 4242 };
	h.child = child; // what spawnClaudeCodeProcess would have recorded
	assert.strictEqual(t.adapter.canSend(h), true);
	t.adapter.stop(h);
	assert.strictEqual(t.sdk.calls[0].closed, true);
	assert.deepStrictEqual(t.kills, [[child, true]]);
	assert.strictEqual(t.adapter.canSend(h), false);
	await t.until(() => t.events.exit.length === 1);
	assert.strictEqual(t.events.exit[0].kind, "exit");
	t.adapter.stop(h); // idempotent
	assert.strictEqual(t.kills.length, 1);
});

test("a prompt becomes a user message; abort interrupts; other requests answer unsupported", async () => {
	const t = await rig();
	const h = t.adapter.start({ cwd: t.cwd }, t.sink);
	await t.until(() => t.events.ready.length === 1);
	assert.strictEqual(t.adapter.send(h, { type: "prompt", message: "hello" }), true);
	await t.until(() => t.sdk.calls[0].calls.includes("user_message"));
	t.adapter.send(h, { type: "abort" });
	await t.until(() => t.sdk.calls[0].interrupted === 1);
	t.adapter.send(h, { id: 7, type: "compact" });
	const resp = t.events.records.find((r) => r.type === "response" && r.id === 7);
	assert.ok(resp && resp.success === false && resp.unsupported === true);
	t.adapter.stop(h);
});

test("CLAUDE.md is appended to the preset; over the cap it is skipped", async () => {
	const small = await rig({ projectFiles: { "CLAUDE.md": "Use tabs." } });
	small.adapter.start({ cwd: small.cwd }, small.sink);
	await small.until(() => small.events.ready.length === 1);
	assert.strictEqual(small.sdk.calls[0].options.systemPrompt.append, "Use tabs.");
	const big = await rig({ projectFiles: { "CLAUDE.md": "x".repeat(CLAUDE_MD_CAP_BYTES + 1) } });
	big.adapter.start({ cwd: big.cwd }, big.sink);
	await big.until(() => big.events.ready.length === 1);
	assert.strictEqual("append" in big.sdk.calls[0].options.systemPrompt, false);
	const none = await rig();
	none.adapter.start({ cwd: none.cwd }, none.sink);
	await none.until(() => none.events.ready.length === 1);
	assert.strictEqual("append" in none.sdk.calls[0].options.systemPrompt, false);
});

test("PI_CRUST_CLAUDE_SDK is honoured only when unpackaged; locate reads a reason, not a crash, without an engine", async () => {
	const seen = [];
	const mk = (packaged) => createClaudeAdapter({ isPackaged: () => packaged, env: { PI_CRUST_CLAUDE_SDK: STAND_IN }, keystore: keystore(), loadSdk: async (spec) => (seen.push(spec), standIn()) });
	const dev = mk(false);
	assert.strictEqual(dev.locate().command, STAND_IN);
	const prod = mk(true);
	assert.strictEqual(prod.locate(), null);
	assert.match(prod.locate.why(), /not installed/);
	const sink = { isCurrent: () => true, ready() {}, record() {}, stderr() {}, exit() {} };
	for (const a of [dev, prod]) {
		const h = a.start({ cwd: tmp }, sink);
		await new Promise((r) => setTimeout(r, 50));
		a.stop(h);
	}
	assert.match(seen[0], /^file:.*claude-sdk-stand-in\.mjs$/);
	assert.strictEqual(seen[1], "@anthropic-ai/claude-agent-sdk");
});

test("the stand-in log shows 'key present', never the key", async () => {
	const sdk = await standIn();
	sdk.reset();
	const logFile = path.join(tmp, "sdk-log.jsonl");
	process.env.PI_CRUST_CLAUDE_SDK_LOG = logFile;
	try {
		const q = sdk.query({ prompt: "x", options: { env: { ANTHROPIC_API_KEY: KEY, PATH: "p" } } });
		q.close();
	} finally {
		delete process.env.PI_CRUST_CLAUDE_SDK_LOG;
	}
	const text = fs.readFileSync(logFile, "utf8");
	assert.match(text, /key present/);
	assert.ok(!text.includes(KEY));
});

test("start: the engine is told to scrub credentials from the tool subprocesses (documented CLAUDE_CODE_SUBPROCESS_ENV_SCRUB), whatever the base env says", async () => {
	const t = await rig({});
	t.adapter.start({ cwd: t.cwd, env: { PATH: "p", CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "0" }, mode: "plan" }, t.sink);
	await t.until(() => t.events.ready.length === 1);
	assert.strictEqual(t.sdk.calls[0].options.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, "1");
});
