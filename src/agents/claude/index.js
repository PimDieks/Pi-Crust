// The Claude agent adapter (phase 7, T4): the shell. It loads the Agent SDK (ESM, dynamic import, one injectable loader), starts one
// long-lived query with streaming input. Every SDK message goes through the translator (translate.js) and the sink gets Pi-shaped
// records; after each result the context meter status and the cost are sent too (status.js). Requests are answered by requests.js,
// history comes from history.js (the SDK's own functions). A request Claude cannot serve answers { success:false, unsupported:true }.
// Key safety: the key goes into the SDK's `env` and nowhere else. This file never logs, never puts the key in an option, an error or a status.
// The engine path comes from one function (enginePath) that returns null with a reason until the download-on-first-use task exists.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const A = require("../adapter");
const { killTree } = require("../../kill-tree");
const { sdkModeFor, makeCanUseTool } = require("./permissions");
const { createTranslator } = require("./translate");
const requests = require("./requests");
const { createHistory } = require("./history");
const status = require("./status");

const DEFAULT_MAX_BUDGET_USD = 5;
const DEFAULT_MAX_TURNS = 100;
const CLAUDE_MD_CAP_BYTES = 32 * 1024;
const NO_KEY = "No Anthropic API key is set. Add one in the Claude Agent key panel, or set ANTHROPIC_API_KEY.";
const NO_CONFIG_DIR = "Claude Agent has no app config folder, so it was not started (it would otherwise use another Claude sign-in).";
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
		fs: deps.fs || fs,
		now: deps.now || Date.now,
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
			const f = cfg.fs;
			const file = path.join(cwd, "CLAUDE.md");
			const lst = f.lstatSync(file);
			if (lst.isSymbolicLink() || !lst.isFile() || lst.size > CLAUDE_MD_CAP_BYTES) return null;
			// A link in a parent folder can still lead out: the real path must lie inside the real project folder.
			const rel = path.relative(f.realpathSync(cwd), f.realpathSync(file));
			if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
			const text = f.readFileSync(file, "utf8");
			return text.trim() ? text : null;
		} catch {
			return null;
		}
	}

	// Fails closed: without the app's own config folder the engine would use an inherited CLAUDE_CONFIG_DIR or the user's own Claude folder.
	function buildEnv(base, key) {
		if (!cfg.configDir) throw new Error(NO_CONFIG_DIR);
		const env = { ...(base || process.env) };
		// Every ANTHROPIC_* and CLAUDE_CODE_* variable (base URL, tokens, flags) and CLAUDE_CONFIG_DIR is dropped; only the ones set below
		// survive. Proxy variables (HTTP_PROXY, HTTPS_PROXY, NO_PROXY ...) are deliberately kept, so a company proxy keeps working.
		for (const k of Object.keys(env)) if (/^(ANTHROPIC_|CLAUDE_CODE_)/i.test(k) || /^CLAUDE_CONFIG_DIR$/i.test(k)) delete env[k];
		env.ANTHROPIC_API_KEY = key;
		env.CLAUDE_CONFIG_DIR = cfg.configDir;
		// Documented (code.claude.com/docs/en/env-vars): strips credentials such as ANTHROPIC_API_KEY from the environments of Bash
		// commands, hooks and stdio MCP servers; on Linux Bash also gets its own PID namespace, out of reach of the engine's /proc.
		env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB = "1";
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

	const history = createHistory({ loadSdk: () => loadSdk(), configDir: () => cfg.configDir, env: process.env });

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
		// What the adapter knows about this chat: its own translator, usage totals, the model and effort in force.
		handle.translator = createTranslator({ now: cfg.now });
		handle.track = status.newTrack();
		handle.meta = { cwd: opts.cwd, sessionId: opts.sessionRef || null, modelId: null, chosen: false, effort: null, streaming: false, lastAssistantText: null, commands: [], permissionMode: null, lastContext: null };
		handle.limits = {};
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
				if (!cfg.configDir) return finish({ kind: "error", error: NO_CONFIG_DIR, errorCode: "NO_CONFIG_DIR" });
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
				const lim = opts.settings || cfg.getSettings() || {};
				handle.limits = { budgetUsd: num(lim.claudeMaxBudgetUsd, DEFAULT_MAX_BUDGET_USD), maxTurns: Math.floor(num(lim.claudeMaxTurns, DEFAULT_MAX_TURNS)) };
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
				if (init && Array.isArray(init.commands)) handle.meta.commands = init.commands;
				if (!sink.isCurrent || sink.isCurrent(handle)) sink.ready(handle, init || {});
				for await (const message of q) {
					if (sink.isCurrent && !sink.isCurrent(handle)) continue;
					emit(handle, handle.translator.push(message));
					if (message && message.type === "result") await afterResult(handle, message);
				}
				finish({ kind: "exit", code: 0, signal: null });
			} catch (e) {
				if (handle.closed) finish({ kind: "exit", code: null, signal: "SIGTERM" });
				else finish({ kind: "error", error: scrub(e && e.message ? e.message : e, key) });
			}
		})();
		return handle;
	}

	// Records to the sink, remembering what the requests need (session, model, streaming, last answer text).
	function emit(h, records) {
		for (const r of records) {
			const m = h.meta;
			if (r.type === "claude_session") {
				m.sessionId = r.sessionId || m.sessionId;
				if (!m.chosen && r.model) m.modelId = r.model;
				if (r.permissionMode) m.permissionMode = r.permissionMode;
			} else if (r.type === "agent_start") m.streaming = true;
			else if (r.type === "agent_settled") m.streaming = false;
			else if (r.type === "message_end" && r.message && r.message.role === "assistant" && r.message.stopReason !== "error") {
				const text = (r.message.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
				if (text) m.lastAssistantText = text;
			}
			h.sink.record(h, r);
		}
	}

	// After every result: the cost and the context meter (getContextUsage, the only live source), and the pause event for a limit stop.
	async function afterResult(h, result) {
		status.trackUsage(h.track, result);
		let usage = null;
		try {
			if (h.query && typeof h.query.getContextUsage === "function") usage = await h.query.getContextUsage();
		} catch {}
		if (usage) h.meta.lastContext = usage;
		const ctx = status.contextStatus(usage || h.meta.lastContext, h.track);
		if (ctx && !(h.sink.isCurrent && !h.sink.isCurrent(h))) h.sink.record(h, status.statusRecord(status.CONTEXT_STATUS_KEY, ctx));
		const pause = status.pauseEvent(result, h.limits);
		if (pause) h.sink.record(h, pause);
	}

	const canSend = (h) => !!h && !h.closed && h.input.open && h.exitCode === null && h.signalCode === null;
	const state = (h) => ({ pid: h.pid, exitCode: h.exitCode, signalCode: h.signalCode });
	const onceExit = (h, cb) => (h.exitCode !== null || h.signalCode !== null ? cb() : h.exitCbs.push(cb));

	function userMessage(r) {
		const content = [{ type: "text", text: String(r.message == null ? "" : r.message) }];
		for (const im of Array.isArray(r.images) ? r.images : []) if (im && im.data) content.push({ type: "image", source: { type: "base64", media_type: im.mimeType || "image/png", data: im.data } });
		return { type: "user", message: { role: "user", content }, parent_tool_use_id: null };
	}

	const answerCtx = (h) => ({
		state: () => ({ ...h.meta }),
		patch: (p) => {
			if (p.modelId) {
				h.meta.modelId = p.modelId;
				h.meta.chosen = true;
			}
			if (p.effort) h.meta.effort = p.effort;
		},
		query: h.query,
		messages: () => history.loadMessages(h.meta.sessionId, { cwd: h.meta.cwd }),
		scrub: (t) => scrub(t),
	});

	// Pi-shaped requests in. A prompt feeds the input stream and its row is emitted here (the stream never echoes it); the rest is
	// answered by requests.js. Every request with an id gets a response record.
	function send(h, record) {
		if (!canSend(h) || !record) return false;
		if (record.type === "prompt") {
			const text = String(record.message == null ? "" : record.message);
			const images = Array.isArray(record.images) ? record.images.filter((im) => im && im.data).map((im) => ({ data: im.data, mimeType: im.mimeType || "image/png" })) : [];
			if (!h.input.push(userMessage(record))) return false;
			emit(h, h.translator.userMessage({ text, images }));
			if (record.id !== undefined) h.sink.record(h, { type: "response", id: record.id, command: "prompt", success: true });
			return true;
		}
		Promise.resolve(requests.answer(record, answerCtx(h))).then(
			(resp) => {
				if (resp && record.id !== undefined && !h.closed) h.sink.record(h, resp);
			},
			() => {},
		);
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
		listSessions: (opts) => history.listSessions(opts || {}),
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
