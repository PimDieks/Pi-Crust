// The Claude agent adapter (phase 7, T4): the shell. It loads the Agent SDK (ESM, dynamic import, one injectable loader), starts one
// long-lived query with streaming input, and passes what the SDK emits on to the sink as { type: "sdk_message", message } records.
// The translation into Pi's record shapes is T5; until then any request other than prompt and abort answers { success:false, unsupported:true }.
// Key safety: the key goes into the SDK's `env` and nowhere else. This file never logs, never puts the key in an option, an error or a status.
// The engine path comes from one function (enginePath) that returns null with a reason until the download-on-first-use task exists.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const A = require("../adapter");
const { killTree } = require("../../kill-tree");
const { sdkModeFor, makeCanUseTool } = require("./permissions");

const DEFAULT_MAX_BUDGET_USD = 5;
const DEFAULT_MAX_TURNS = 100;
const CLAUDE_MD_CAP_BYTES = 32 * 1024;
const NO_KEY = "No Anthropic API key is set. Add one in the Claude Agent key panel, or set ANTHROPIC_API_KEY.";
const NO_ENGINE = "The Claude Agent engine is not installed yet.";

// Capability values for Claude, as data (plan section 2). A false flag hides or disables the control with a reason.
const CAPABILITIES = A.capabilities({
	steering: false,
	followUpQueue: false,
	thinkingLevels: true, // effort
	modelSwitch: true,
	slashCommands: true,
	extensions: false,
	contextBreakdown: true,
	checkpoints: true,
	conversationRewind: false,
	fork: false,
	clone: false,
	exportHtml: false,
	compact: false,
	sessionStats: false,
	sessionName: false,
	sessionResume: true,
	subagentCards: false,
	advisor: false,
	costMeter: true,
	images: true,
	mcpConfig: true,
	auth: true,
	readyOnSpawn: true, // initializationResult() is the readiness check, no probe
});

// The one place that knows where the engine is. null (with a reason) until the download task exists.
function enginePath() {
	return { path: null, reason: NO_ENGINE + " It is downloaded the first time you pick Claude Agent." };
}

// A message with every occurrence of the key removed (errors from the SDK might echo it).
function scrub(text, key) {
	let s = String(text == null ? "" : text);
	if (key && typeof key === "string") s = s.split(key).join("[key]");
	return s.replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, "[key]");
}

function defaultIsPackaged() {
	try {
		const e = require("electron");
		return !(e && e.app && e.app.isPackaged === false); // anything unclear counts as packaged: the stand-in switch fails closed
	} catch {
		return true;
	}
}

function createClaudeAdapter(deps = {}) {
	const cfg = {
		keystore: deps.keystore || null, // { read(), status(), set(), clear() } from keystore.js; the app sets it with configure()
		configDir: deps.configDir || null, // app-owned CLAUDE_CONFIG_DIR: the user's own Claude sign-in is never used
		getSettings: deps.getSettings || (() => ({})),
		isPackaged: deps.isPackaged || defaultIsPackaged,
		loadSdk: deps.loadSdk || null,
		killTree: deps.killTree || killTree,
		enginePath: deps.enginePath || enginePath,
		env: deps.env || process.env,
	};
	const num = (v, d) => (v !== null && v !== "" && v !== undefined && Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);

	// The SDK, loaded once through one loader. PI_CRUST_CLAUDE_SDK swaps in a stand-in, only when the app is not packaged.
	let sdkPromise = null;
	function loadSdk() {
		if (!sdkPromise) {
			const standIn = !cfg.isPackaged() && cfg.env.PI_CRUST_CLAUDE_SDK;
			const loader = cfg.loadSdk || ((spec) => import(spec));
			sdkPromise = Promise.resolve()
				.then(() => loader(standIn ? pathToFileURL(path.resolve(String(standIn))).href : "@anthropic-ai/claude-agent-sdk"))
				.catch((e) => {
					sdkPromise = null;
					throw new Error("The Claude Agent SDK could not be loaded: " + scrub(e && e.message));
				});
		}
		return sdkPromise;
	}

	// The project's root CLAUDE.md, when present and not over the cap; instructions yes, project settings no.
	function readClaudeMd(cwd) {
		try {
			const file = path.join(cwd, "CLAUDE.md");
			const st = fs.statSync(file);
			if (!st.isFile() || st.size > CLAUDE_MD_CAP_BYTES) return null;
			const text = fs.readFileSync(file, "utf8");
			return text.trim() ? text : null;
		} catch {
			return null;
		}
	}

	function buildEnv(base, key) {
		const env = { ...(base || process.env), ANTHROPIC_API_KEY: key };
		delete env.ANTHROPIC_AUTH_TOKEN;
		delete env.CLAUDE_CODE_OAUTH_TOKEN;
		if (cfg.configDir) env.CLAUDE_CONFIG_DIR = cfg.configDir;
		return env;
	}

	// The SDK options. The key appears only inside options.env.
	function buildOptions(opts, key, extra = {}) {
		const settings = (opts.settings && typeof opts.settings === "object" ? opts.settings : null) || cfg.getSettings() || {};
		const engine = cfg.enginePath();
		const appendText = opts.claudeMd === false ? null : readClaudeMd(opts.cwd);
		const o = {
			cwd: opts.cwd,
			env: buildEnv(opts.env, key),
			settingSources: [],
			includePartialMessages: true,
			systemPrompt: { type: "preset", preset: "claude_code", ...(appendText ? { append: appendText } : {}) },
			maxBudgetUsd: num(settings.claudeMaxBudgetUsd, DEFAULT_MAX_BUDGET_USD),
			maxTurns: Math.floor(num(settings.claudeMaxTurns, DEFAULT_MAX_TURNS)),
			...sdkModeFor(opts.mode),
			...extra,
		};
		if (engine && engine.path) o.pathToClaudeCodeExecutable = engine.path;
		if (opts.sessionRef) o.resume = opts.sessionRef;
		return o;
	}

	// A queue the SDK reads as streaming input.
	function inputQueue() {
		const items = [];
		let wake = null;
		let ended = false;
		const poke = () => {
			if (wake) {
				const w = wake;
				wake = null;
				w();
			}
		};
		return {
			push(m) {
				if (ended) return false;
				items.push(m);
				poke();
				return true;
			},
			end() {
				ended = true;
				poke();
			},
			get open() {
				return !ended;
			},
			async *[Symbol.asyncIterator]() {
				for (;;) {
					if (items.length) yield items.shift();
					else if (ended) return;
					else await new Promise((r) => (wake = r));
				}
			},
		};
	}

	function closeQuery(handle) {
		try {
			if (handle.query && typeof handle.query.close === "function") handle.query.close();
		} catch {}
	}

	// opts: { cwd, env?, settings?, sessionRef?, mode?, ask? }. Returns the handle at once; readiness and failures come through the sink.
	function start(opts, sink) {
		const handle = { pid: undefined, exitCode: null, signalCode: null, query: null, input: inputQueue(), child: null, closed: false, exitCbs: [], sink, mode: opts.mode };
		const finish = (info) => {
			if (handle.exitCode !== null || handle.signalCode !== null) return;
			if (info && info.signal) handle.signalCode = info.signal;
			else handle.exitCode = info && info.code != null ? info.code : 0;
			handle.input.end();
			try {
				sink.exit(handle, info);
			} finally {
				for (const cb of handle.exitCbs.splice(0)) cb();
			}
		};
		(async () => {
			let key = null;
			try {
				const k = cfg.keystore ? await cfg.keystore.read() : { key: null };
				key = k && k.key;
				if (!key) return finish({ kind: "error", error: (k && k.reason) || NO_KEY, errorCode: "NO_KEY" });
				const sdk = await loadSdk();
				if (handle.closed) return finish({ kind: "exit", code: null, signal: "SIGTERM" });
				const canUseTool = makeCanUseTool({
					getMode: () => handle.mode,
					ask: (prompt, meta) => (typeof opts.ask === "function" ? opts.ask(prompt, meta) : sink.ask ? sink.ask(handle, prompt, meta) : undefined),
					cwd: opts.cwd,
				});
				handle.canUseTool = canUseTool;
				const options = buildOptions(opts, key, {
					canUseTool,
					// Lets stop() tree-kill the engine process (the SDK does not give us its pid otherwise).
					spawnClaudeCodeProcess: (so) => {
						const child = require("node:child_process").spawn(so.command, so.args, { cwd: so.cwd, env: so.env, stdio: ["pipe", "pipe", "ignore"], windowsHide: true, signal: so.signal });
						handle.child = child;
						handle.pid = child.pid;
						return child;
					},
				});
				const q = sdk.query({ prompt: handle.input, options });
				handle.query = q;
				if (handle.closed) {
					closeQuery(handle);
					return finish({ kind: "exit", code: null, signal: "SIGTERM" });
				}
				const init = typeof q.initializationResult === "function" ? await q.initializationResult() : {};
				if (!sink.isCurrent || sink.isCurrent(handle)) sink.ready(handle, init || {});
				for await (const message of q) {
					if (sink.isCurrent && !sink.isCurrent(handle)) continue;
					sink.record(handle, { type: "sdk_message", message });
					// A budget stop is its own event, so the UI can offer Continue later.
					if (message && message.type === "result" && message.subtype === "error_max_budget_usd") {
						sink.record(handle, { type: "claude_budget_reached", total_cost_usd: message.total_cost_usd, session_id: message.session_id });
					}
				}
				finish({ kind: "exit", code: 0, signal: null });
			} catch (e) {
				if (handle.closed) finish({ kind: "exit", code: null, signal: "SIGTERM" });
				else finish({ kind: "error", error: scrub(e && e.message ? e.message : e, key) });
			}
		})();
		return handle;
	}

	const canSend = (h) => !!h && !h.closed && h.input.open && h.exitCode === null && h.signalCode === null;
	const state = (h) => ({ pid: h.pid, exitCode: h.exitCode, signalCode: h.signalCode });
	const onceExit = (h, cb) => (h.exitCode !== null || h.signalCode !== null ? cb() : h.exitCbs.push(cb));

	function userMessage(r) {
		const content = [{ type: "text", text: String(r.message == null ? "" : r.message) }];
		for (const im of Array.isArray(r.images) ? r.images : []) if (im && im.data) content.push({ type: "image", source: { type: "base64", media_type: im.mimeType || "image/png", data: im.data } });
		return { type: "user", message: { role: "user", content }, parent_tool_use_id: null };
	}

	// Pi-shaped requests in. Only prompt and abort are served in T4; the rest answers unsupported (T5 adds them).
	function send(h, record) {
		if (!canSend(h) || !record) return false;
		if (record.type === "prompt") return h.input.push(userMessage(record));
		if (record.type === "abort") {
			if (h.query && typeof h.query.interrupt === "function") Promise.resolve(h.query.interrupt()).catch(() => {});
			return true;
		}
		if (record.id !== undefined && h.sink) h.sink.record(h, { type: "response", id: record.id, command: record.type, success: false, unsupported: true, error: "Not available for Claude Agent chats." });
		return true;
	}

	// Closes the query (which ends the engine), then tree-kills the child when we hold it.
	function stop(h) {
		if (!h || h.closed) return;
		h.closed = true;
		h.input.end();
		closeQuery(h);
		if (h.child) {
			try {
				cfg.killTree(h.child, true);
			} catch {}
		}
	}

	function killRemains(h, { sync = false } = {}) {
		if (h && h.child) {
			try {
				cfg.killTree(h.child, true, { sync });
			} catch {}
		}
	}

	// The one tiny test request on save. Never returns or throws the key.
	async function check(key) {
		if (typeof key !== "string" || !key.trim()) return { ok: false, error: NO_KEY };
		key = key.trim();
		let q;
		try {
			const sdk = await loadSdk();
			const options = buildOptions({ cwd: cfg.configDir || process.cwd(), claudeMd: false }, key, { maxTurns: 1, maxBudgetUsd: 0.05, tools: [], canUseTool: async () => ({ behavior: "deny", message: "No tools in a key check." }) });
			delete options.systemPrompt;
			q = sdk.query({ prompt: "Reply with the single word: ok", options });
			for await (const m of q) {
				if (m && m.type === "result") {
					if (m.is_error || (typeof m.subtype === "string" && m.subtype.startsWith("error"))) return { ok: false, error: scrub((Array.isArray(m.errors) && m.errors[0]) || m.result || "The key was not accepted.", key) };
					return { ok: true };
				}
			}
			return { ok: false, error: "No answer came back." };
		} catch (e) {
			return { ok: false, error: scrub(e && e.message, key) };
		} finally {
			try {
				if (q && q.close) q.close();
			} catch {}
		}
	}

	const auth = {
		async status() {
			if (!cfg.keystore) return { source: "none", reason: NO_KEY };
			try {
				const s = await cfg.keystore.status();
				return s && s.reason ? { source: s.source, reason: String(s.reason) } : { source: s ? s.source : "none" };
			} catch {
				return { source: "none" };
			}
		},
		check,
		async login(key) {
			const r = await check(key);
			if (!r.ok) return r;
			await cfg.keystore.set(key);
			return { ok: true };
		},
		async logout() {
			return cfg.keystore ? cfg.keystore.clear() : { ok: true };
		},
	};

	// The located engine: the stand-in under test, otherwise whatever enginePath() says. null while there is none.
	function locate() {
		if (!cfg.isPackaged() && cfg.env.PI_CRUST_CLAUDE_SDK) return { installed: true, command: String(cfg.env.PI_CRUST_CLAUDE_SDK), args: [], binDir: path.dirname(String(cfg.env.PI_CRUST_CLAUDE_SDK)) };
		const e = cfg.enginePath();
		if (!e || !e.path) return null;
		return { installed: true, command: e.path, args: [], binDir: path.dirname(e.path) };
	}
	// The readable reason locate() returned null.
	locate.why = () => {
		const e = cfg.enginePath();
		return e && e.path ? null : (e && e.reason) || NO_ENGINE;
	};

	const adapter = {
		id: "claude",
		label: "Claude Agent",
		capabilities: CAPABILITIES,
		strings: {
			notInstalled: NO_ENGINE,
			notRunning: "Claude Agent is not running",
			stopped: "Claude Agent stopped",
			noAnswer: "Claude Agent did not answer in time",
			refused: "Claude Agent refused the request",
			noKey: NO_KEY,
		},
		locate,
		pathExtras: () => [],
		start,
		canSend,
		send,
		stop,
		state,
		onceExit,
		killRemains,
		listSessions: () => [], // stub: the SDK's session listing comes with T8
		auth,
		mcpConfigPath: () => null,
		onAppStart: () => {},
		// The app hands over its pieces once it has them (userData folder, safeStorage, settings).
		configure(next = {}) {
			for (const k of ["keystore", "configDir", "getSettings", "isPackaged", "loadSdk", "killTree", "enginePath"]) if (next[k] !== undefined) cfg[k] = next[k];
			sdkPromise = null;
			return adapter;
		},
	};
	return A.assertAdapter(adapter);
}

module.exports = createClaudeAdapter();
module.exports.createClaudeAdapter = createClaudeAdapter;
module.exports.CAPABILITIES = CAPABILITIES;
module.exports.CLAUDE_MD_CAP_BYTES = CLAUDE_MD_CAP_BYTES;
module.exports.DEFAULT_MAX_BUDGET_USD = DEFAULT_MAX_BUDGET_USD;
module.exports.NO_KEY = NO_KEY;
module.exports.scrub = scrub;
