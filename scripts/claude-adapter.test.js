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

async function rig({ key = KEY, killTree, loadSdk, projectFiles = {}, settings = {}, env = {}, configDir = path.join(tmp, "claude-config"), fsImpl } = {}) {
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
	const adapter = createClaudeAdapter({ enginePath: () => ({ path: "C:/stub/claude.exe" }), keystore: keystore(key), configDir, ...(fsImpl ? { fs: fsImpl } : {}), isPackaged: () => false, loadSdk: realLoad, killTree: killTree || ((p, f) => kills.push([p, f])), getSettings: () => settings, env });
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
	assert.deepStrictEqual(c.options.thinking, { type: "adaptive", display: "summarized" }, "thinking text is asked for as a summary");
	assert.deepStrictEqual(c.options.systemPrompt, { type: "preset", preset: "claude_code" });
	t.adapter.stop(h0);
});

test("the budget comes from a setting; a result of error_max_budget_usd is its own event", async () => {
	const t = await rig({ settings: { claudeMaxBudgetUsd: 2.5 } });
	t.sdk.setScript([{ type: "result", subtype: "error_max_budget_usd", is_error: true, total_cost_usd: 2.51, session_id: "s" }]);
	const h = t.adapter.start({ cwd: t.cwd, mode: "plan" }, t.sink);
	await t.until(() => t.events.ready.length === 1);
	assert.strictEqual(t.sdk.calls[0].options.maxBudgetUsd, 2.5);
	assert.strictEqual(t.sdk.calls[0].options.permissionMode, "default", "Plan runs the SDK in default too; our gate blocks");
	assert.ok(t.adapter.send(h, { type: "prompt", message: "hi" }));
	await t.until(() => t.events.records.some((r) => r.type === "claude_paused"));
	assert.strictEqual(t.events.records.find((r) => r.type === "claude_paused").totalCostUsd, 2.51);
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
	assert.ok(!("systemPrompt" in o), "check() sends no system prompt");
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
	await t.until(() => t.events.records.some((r) => r.type === "response" && r.id === 7));
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
	const mk = (packaged) => createClaudeAdapter({ configDir: path.join(tmp, "cfg"), isPackaged: () => packaged, env: { PI_CRUST_CLAUDE_SDK: STAND_IN }, keystore: keystore(), loadSdk: async (spec) => (seen.push(spec), standIn()) });
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

// The packaged app as the adapter sees it: no isPackaged injected, so it asks Electron (app.isPackaged), exactly as in the installed app. The
// electron module is replaced for the length of the test by one that answers like the packaged app, and like the unpackaged one as the control.
test("packaged app (app.isPackaged true): PI_CRUST_CLAUDE_SDK does nothing, the real SDK is the only one loaded, and without the engine nothing starts", async () => {
	const key = require.resolve("electron");
	const had = require.cache[key];
	const withElectron = async (app, fn) => {
		require.cache[key] = { id: key, filename: key, loaded: true, exports: { app } };
		try {
			return await fn();
		} finally {
			if (had) require.cache[key] = had;
			else delete require.cache[key];
		}
	};
	const seen = [];
	let queries = 0;
	const sdk = async () => ({ ...(await standIn()), query: () => (queries++, assert.fail("the engine was started")) });
	const mk = () => createClaudeAdapter({ configDir: path.join(tmp, "cfg-packaged"), env: { PI_CRUST_CLAUDE_SDK: STAND_IN }, keystore: keystore(), loadSdk: async (spec) => (seen.push(spec), sdk()) });
	const events = [];
	const sink = { isCurrent: () => true, ready: () => events.push("ready"), record() {}, stderr() {}, exit: (h, i) => events.push(i) };
	await withElectron({ isPackaged: true }, async () => {
		const a = mk();
		assert.strictEqual(a.locate(), null, "the stand-in is not a program in a packaged app");
		const h = a.start({ cwd: tmp }, sink);
		await new Promise((r) => setTimeout(r, 150));
		a.stop(h);
	});
	assert.deepStrictEqual(seen, ["@anthropic-ai/claude-agent-sdk"]);
	assert.strictEqual(queries, 0);
	assert.ok(!events.includes("ready"));
	assert.strictEqual(events[0] && events[0].kind, "error");
	assert.match(String(events[0].error), /engine is not installed/);
	// control: the same adapter in an unpackaged app does use the stand-in
	seen.length = 0;
	await withElectron({ isPackaged: false }, async () => {
		const a = mk();
		assert.strictEqual(a.locate().command, STAND_IN);
		const h = a.start({ cwd: tmp }, { ...sink, exit() {} });
		await new Promise((r) => setTimeout(r, 150));
		a.stop(h);
	});
	assert.match(seen[0], /claude-sdk-stand-in\.mjs$/);
	// and when Electron cannot be asked at all, it counts as packaged
	require.cache[key] = { id: key, filename: key, loaded: true, exports: {} };
	try {
		assert.strictEqual(mk().locate(), null);
	} finally {
		if (had) require.cache[key] = had;
		else delete require.cache[key];
	}
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

test("start: the engine's non-essential traffic is off (documented switches), also when the base env tries to turn them on or off", async () => {
	const t = await rig({});
	const env = { PATH: "p", CLAUDE_CODE_ENABLE_TELEMETRY: "1", DISABLE_TELEMETRY: "", CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: "0" };
	t.adapter.start({ cwd: t.cwd, env, mode: "plan" }, t.sink);
	await t.until(() => t.events.ready.length === 1);
	const o = t.sdk.calls[0].options.env;
	for (const n of ["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "DISABLE_TELEMETRY", "DISABLE_ERROR_REPORTING", "DISABLE_AUTOUPDATER", "DISABLE_UPDATES", "DISABLE_FEEDBACK_COMMAND", "CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY", "CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL", "CLAUDE_CODE_DISABLE_FEATURE_FLAGS", "CLAUDE_CODE_DISABLE_BUNDLED_SKILLS"]) assert.strictEqual(o.switches[n], "1", n);
	assert.ok(!o.names.includes("CLAUDE_CODE_ENABLE_TELEMETRY"));
});

test("start: inherited variables that can reconfigure the engine are dropped; proxy and CA variables stay", async () => {
	const t = await rig({});
	const bad = ["NODE_OPTIONS", "BASH_ENV", "API_TIMEOUT_MS", "USE_BUILTIN_RIPGREP", "MAX_THINKING_TOKENS", "MAX_MCP_OUTPUT_TOKENS", "MCP_TIMEOUT", "MCP_SERVER_CONNECTION_BATCH_SIZE", "OTEL_EXPORTER_OTLP_ENDPOINT", "ENABLE_TOOL_SEARCH", "DISABLE_COST_WARNINGS", "BETA_TRACING_ENDPOINT", "max_foo", "Node_Options"];
	const keep = ["PATH", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "NODE_EXTRA_CA_CERTS", "HOME", "MAXIMUM", "ENABLED_BY_ME"];
	const env = {};
	for (const n of [...bad, ...keep]) env[n] = "x";
	t.adapter.start({ cwd: t.cwd, env, mode: "plan" }, t.sink);
	await t.until(() => t.events.ready.length === 1);
	const o = t.sdk.calls[0].options.env;
	for (const n of bad) assert.ok(!o.names.includes(n), `${n} was passed on`);
	for (const n of keep) assert.ok(o.names.includes(n), `${n} was dropped`);
	for (const n of ["DISABLE_TELEMETRY", "DISABLE_UPDATES"]) assert.strictEqual(o.switches[n], "1", n); // the app's own DISABLE_* still set
});

test("start: inherited variables with secret-looking names are dropped; ordinary ones and the app's own key stay", async () => {
	const t = await rig({});
	const bad = ["OPENAI_API_KEY", "openai_api_key", "GEMINI_APIKEY", "GITHUB_TOKEN", "GH_TOKEN", "NPM_TOKEN", "AWS_SESSION_TOKEN", "AWS_SECRET_ACCESS_KEY", "AWS_ACCESS_KEY", "AZURE_CLIENT_SECRET", "DB_PASSWORD", "PGPASSWORD", "MYSQL_PWD", "SVC_PASSWD", "GOOGLE_APPLICATION_CREDENTIALS", "SSH_PRIVATE_KEY", "GITHUB_PAT", "STRIPE_SECRET_KEY_LIVE_SECRET", "TOKEN", "SECRET", "MY_TOKEN_FILE_TOKEN", "FOO_SECRET_BAR", "DATABASE_URL", "REDIS_URL", "MONGODB_URI", "ORDERS_CONNECTION_STRING", "SENTRY_DSN", "REPORTING_DATABASE_URL"];
	const keep = ["PATH", "SystemRoot", "TEMP", "APPDATA", "USERPROFILE", "LOCALAPPDATA", "HOME", "HTTPS_PROXY", "NO_PROXY", "NODE_EXTRA_CA_CERTS", "SSH_AUTH_SOCK", "KEYBOARD_LAYOUT", "TOKENIZERS_NOTE", "SECRETARY", "PWD", "COMSPEC", "PATHEXT", "AWS_PROFILE", "EDITOR", "PASSWORD_POLICY_URL_DOC"];
	const env = {};
	for (const n of [...bad, ...keep]) env[n] = "dummy-value-" + n;
	t.adapter.start({ cwd: t.cwd, env, mode: "plan" }, t.sink);
	await t.until(() => t.events.ready.length === 1);
	const o = t.sdk.calls[0].options.env;
	for (const n of bad) assert.ok(!o.names.includes(n), `${n} was passed on`);
	for (const n of keep) assert.ok(o.names.includes(n), `${n} was dropped`);
	assert.ok(o.names.includes("ANTHROPIC_API_KEY"), "the app's own key arrives");
});

test("start: more secret-looking names (signing keys, webhooks, cookies, auth) are dropped; ordinary look-alikes and SSH_AUTH_SOCK stay", async () => {
	const t = await rig({});
	const bad = ["STRIPE_SK", "SLACK_WEBHOOK_URL", "JWT_SIGNING_KEY", "SIGNING_KEY", "SECRET_KEY", "SESSION_COOKIE", "PASSPHRASE", "OPENAI_KEY", "AUTH_KEY", "AUTHORIZATION", "NPM_CONFIG__AUTH", "GPG_PASSPHRASE", "KEY"];
	const keep = ["PATH", "PATHEXT", "SystemRoot", "ComSpec", "TEMP", "TMP", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "ProgramFiles", "PSModulePath", "GIT_AUTHOR_NAME", "GIT_EDITOR", "SSH_AUTH_SOCK", "TOKENIZERS_PARALLELISM", "KEYBOARD_LAYOUT", "MONKEY_PATCH", "KUBECONFIG", "AWS_PROFILE", "HOMEBREW_PREFIX"];
	const env = {};
	for (const n of [...bad, ...keep]) env[n] = "dummy-value-" + n;
	t.adapter.start({ cwd: t.cwd, env, mode: "plan" }, t.sink);
	await t.until(() => t.events.ready.length === 1);
	const o = t.sdk.calls[0].options.env;
	for (const n of bad) assert.ok(!o.names.includes(n), `${n} was passed on`);
	for (const n of keep) assert.ok(o.names.includes(n), `${n} was dropped`);
});

test("start: dropped secret-looking variables leave no trace in records, stderr or errors", async () => {
	const t = await rig({});
	const env = { PATH: "p", OPENAI_API_KEY: "LEAKVALUE1", EXTRA_SECRET_THING_TOKEN: "LEAKVALUE2" };
	t.adapter.start({ cwd: t.cwd, env, mode: "plan" }, t.sink);
	await t.until(() => t.events.ready.length === 1);
	const seen = JSON.stringify([t.events, t.sdk.calls.map((c) => ({ ...c, options: { ...c.options, env: undefined } }))]);
	for (const never of ["LEAKVALUE1", "LEAKVALUE2", "OPENAI_API_KEY", "EXTRA_SECRET_THING_TOKEN"]) assert.ok(!seen.includes(never), never);
});

test("no config folder: nothing starts, with a readable error, and check fails too", async () => {
	const t = await rig({ configDir: null });
	t.adapter.start({ cwd: t.cwd }, t.sink);
	await t.until(() => t.events.exit.length === 1);
	assert.strictEqual(t.events.exit[0].kind, "error");
	assert.match(t.events.exit[0].error, /config folder/);
	assert.strictEqual(t.sdk.calls.length, 0);
	const c = await t.adapter.auth.check(KEY);
	assert.strictEqual(c.ok, false);
	assert.strictEqual(t.sdk.calls.length, 0);
});

test("start: inherited ANTHROPIC_* and CLAUDE_CODE_* variables and CLAUDE_CONFIG_DIR are dropped; proxy variables stay", async () => {
	const t = await rig({});
	const env = { PATH: "p", HTTPS_PROXY: "http://proxy:1", NO_PROXY: "x", ANTHROPIC_BASE_URL: "http://evil", ANTHROPIC_MODEL: "m", CLAUDE_CODE_USE_BEDROCK: "1", claude_code_extra: "1", CLAUDE_CONFIG_DIR: "C:\\users\\me\\.claude" };
	t.adapter.start({ cwd: t.cwd, env, mode: "plan" }, t.sink);
	await t.until(() => t.events.ready.length === 1);
	const o = t.sdk.calls[0].options.env;
	for (const n of ["ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL", "CLAUDE_CODE_USE_BEDROCK", "claude_code_extra"]) assert.ok(!o.names.includes(n), n);
	for (const n of ["PATH", "HTTPS_PROXY", "NO_PROXY", "ANTHROPIC_API_KEY", "CLAUDE_CODE_SUBPROCESS_ENV_SCRUB"]) assert.ok(o.names.includes(n), n);
	assert.strictEqual(o.CLAUDE_CONFIG_DIR, path.join(tmp, "claude-config"));
});

test("CLAUDE.md: a link to a file outside the project is refused (injected fs, then a real link when the machine allows)", async () => {
	const proj = path.join(tmp, "fake-proj");
	const mkFs = (over) => ({
		lstatSync: () => ({ isSymbolicLink: () => false, isFile: () => true, size: 5 }),
		realpathSync: (p) => p,
		readFileSync: () => "SECRET",
		...over,
	});
	const read = async (fsImpl) => {
		const t = await rig({ fsImpl });
		t.adapter.start({ cwd: proj }, t.sink);
		await t.until(() => t.events.ready.length === 1);
		return t.sdk.calls[0].options.systemPrompt;
	};
	assert.strictEqual((await read(mkFs())).append, "SECRET", "control: a plain file is read");
	assert.ok(!("append" in (await read(mkFs({ lstatSync: () => ({ isSymbolicLink: () => true, isFile: () => true, size: 5 }) })))), "symlink refused");
	assert.ok(!("append" in (await read(mkFs({ realpathSync: (p) => (p.endsWith("CLAUDE.md") ? path.join(tmp, "elsewhere", "x.md") : p) })))), "real path outside refused");
	const t = await rig({});
	const target = path.join(tmp, "secret-" + path.basename(t.cwd) + ".md");
	fs.writeFileSync(target, "OUTSIDE");
	try {
		fs.symlinkSync(target, path.join(t.cwd, "CLAUDE.md"));
	} catch {
		return; // no symlink right on this machine: the injected cases above cover it
	}
	t.adapter.start({ cwd: t.cwd }, t.sink);
	await t.until(() => t.events.ready.length === 1);
	assert.ok(!("append" in t.sdk.calls[0].options.systemPrompt));
});

test("scrub removes the exact key and any sk-ant- shaped token, each on its own", () => {
	const { scrub } = require("../src/agents/claude");
	assert.strictEqual(scrub("bad my-plain-secret-123 here", "my-plain-secret-123"), "bad [key] here");
	assert.strictEqual(scrub("a sk-ant-abcdefgh1234 b"), "a [key] b");
	assert.strictEqual(scrub("a sk-ant-abcdefgh1234 b", "other-key"), "a [key] b");
	assert.strictEqual(scrub(null), "");
	assert.strictEqual(scrub("plain", 5), "plain");
});

test("every record that leaves the adapter is scrubbed: tool output, error results, assistant errors and task notifications never carry the key", async () => {
	const t = await rig();
	const echo = "key is " + KEY + " done";
	t.sdk.setScript([
		{ type: "system", subtype: "init", session_id: "s1", model: "claude-haiku-5-5", permissionMode: "default" },
		{ type: "system", subtype: "status", status: "requesting" },
		{ type: "stream_event", event: { type: "message_start" } },
		{ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: "Agent", input: {} } } },
		{ type: "stream_event", event: { type: "content_block_stop", index: 0 } },
		{ type: "stream_event", event: { type: "message_stop" } },
		{ type: "system", subtype: "task_started", task_id: "k1", tool_use_id: "t1", description: "d" },
		{ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: echo }] }, tool_use_result: { status: "async_launched" } },
		{ type: "assistant", error: "unknown", message: { content: [{ type: "text", text: echo }] } },
		{ type: "result", subtype: "error_during_execution", is_error: true, errors: [echo], session_id: "s1" },
		{ type: "system", subtype: "task_notification", task_id: "k1", tool_use_id: "t1", status: "completed", summary: echo },
	]);
	const h = t.adapter.start({ cwd: t.cwd }, t.sink);
	await t.until(() => t.events.ready.length === 1);
	t.adapter.send(h, { type: "prompt", message: "hi" });
	await t.until(() => t.events.records.some((r) => r.type === "tool_execution_end" && r.toolCallId === "t1"));
	const all = JSON.stringify(t.events.records);
	assert.ok(!all.includes(KEY), "the key is not in any record");
	assert.ok(all.includes("[key]"), "the text is there, with the key replaced");
	assert.ok(t.events.records.some((r) => r.type === "message_end" && r.message.errorMessage), "an error row was emitted");
	t.adapter.stop(h);
});
