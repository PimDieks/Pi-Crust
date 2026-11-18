// The Claude agent adapter (phase 7, T4): the shell. It loads the Agent SDK (ESM, dynamic import, one injectable loader), starts one
// long-lived query with streaming input. Every SDK message goes through the translator (translate.js) and the sink gets Pi-shaped
// records; after each result the context meter status and the cost are sent too (status.js). Requests are answered by requests.js,
// history comes from history.js (the SDK's own functions). A request Claude cannot serve answers { success:false, unsupported:true }.
// Key safety: the key goes into the SDK's `env` and nowhere else. This file never logs, never puts the key in an option, an error or a status.
// The engine path comes from one function (enginePath) that returns null with a reason until the download-on-first-use task exists.
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const A = require("../adapter");
const { killTree } = require("../../kill-tree");
const logic = require("../../permission-logic");
const { sdkModeFor, makeCanUseTool, makeHooks } = require("./permissions");
const { createTranslator } = require("./translate");
const requests = require("./requests");
const { createHistory } = require("./history");
const status = require("./status");
const turnsLib = require("./turns");

const DEFAULT_MAX_BUDGET_USD = 5;
const DEFAULT_MAX_TURNS = 100;
const CLAUDE_MD_CAP_BYTES = 32 * 1024;
const NO_KEY = "No Anthropic API key is set. Add one in the Claude Agent key panel, or set ANTHROPIC_API_KEY.";
const NO_CONFIG_DIR = "Claude Agent has no app config folder, so it was not started (it would otherwise use another Claude sign-in).";
const NO_ENGINE = "The Claude Agent engine is not installed yet.";
// Slash commands the SDK would run itself when a message starts with "/" (they can change settings, add folders, plugins, MCP servers or hooks,
// or sign in). Only these harmless, read-only ones are forwarded; every other command is answered locally as not available. Decided from the
// engine's own command list (capture-info.jsonl): they show the context, the usage and the recap, or the unused skills.
const SLASH_ALLOW = Object.freeze(["context", "usage", "recap", "skill-doctor"]);
// A command is a first token of "/" plus a name of letters, digits, dashes, underscores and colons (namespaced and MCP-style names such as
// /plugin:cmd and /mcp__srv__x), and nothing else: no "/" and no "." ("/src/a.js broken" is ordinary text).
const SLASH_START = /^[\s\u200b\ufeff]*\/([A-Za-z0-9_:-]+)(?=\s|$)/;
const MODE_FILE = "crust-permission-mode.json"; // the last chosen mode, in the app's own config folder (Pi keeps the same in its own folder)
const MODE_COMMAND = /^\s*\/crust-mode(?:\s+(\S+))?\s*$/i; // what the mode selector sends; handled here, never given to the model

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
	conversationRewind: true, // resume + forkSession + resumeSessionAt, in the chat's own tab (turns.js)
	fork: true, // the same in a new tab: /fork from the end or from an earlier message
	clone: false, // would be fork from the end; kept off because Pi's /clone replaces the chat in place and this would open a tab
	exportHtml: false,
	compact: false,
	sessionStats: false,
	sessionName: false,
	sessionResume: true,
	subagentCards: true, // the translator turns an Agent call into the same subagent card as Pi's (translate.js)
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

// A record with the key scrubbed out of every string in it (error text, tool output, task notifications: anything the engine says may
// echo the key). Returns the same object when nothing changed.
function scrubDeep(v, key) {
	if (typeof v === "string") return v.includes("sk-ant-") || (key && v.includes(key)) ? scrub(v, key) : v;
	if (Array.isArray(v)) {
		let out = null;
		v.forEach((x, i) => {
			const y = scrubDeep(x, key);
			if (y !== x) (out = out || v.slice())[i] = y;
		});
		return out || v;
	}
	if (v && typeof v === "object") {
		let out = null;
		for (const k of Object.keys(v)) {
			const y = scrubDeep(v[k], key);
			if (y !== v[k]) (out = out || { ...v })[k] = y;
		}
		return out || v;
	}
	return v;
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
		uuid: deps.uuid || (() => crypto.randomUUID()),
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
		// Never without a verified engine: without pathToClaudeCodeExecutable the SDK would search node_modules folders up the tree.
		// The path comes only from the setup's engine status "ready" (engine.js). The stand-in SDK of a self-test (unpackaged only) needs none.
		const engine = cfg.enginePath();
		const standIn = !cfg.isPackaged() && !!cfg.env.PI_CRUST_CLAUDE_SDK;
		if ((!engine || typeof engine.path !== "string" || !engine.path) && !standIn) throw new Error(NO_ENGINE);
		const appendText = opts.claudeMd === false ? null : readClaudeMd(opts.cwd);
		const o = {
			cwd: opts.cwd,
			env: buildEnv(opts.env, key),
			settingSources: [],
			includePartialMessages: true,
			systemPrompt: { type: "preset", preset: "claude_code", ...(appendText ? { append: appendText } : {}) },
			maxBudgetUsd: num(settings.claudeMaxBudgetUsd, DEFAULT_MAX_BUDGET_USD),
			maxTurns: Math.floor(num(settings.claudeMaxTurns, DEFAULT_MAX_TURNS)),
			// Thinking text is returned as a summary, so a Claude Agent chat shows its thinking as a Pi chat does (the default is no text).
			thinking: { type: "adaptive", display: "summarized" },
			...sdkModeFor(opts.mode),
			...extra,
		};
		if (engine && engine.path) o.pathToClaudeCodeExecutable = engine.path;
		if (opts.sessionRef) o.resume = opts.sessionRef;
		return o;
	}

	// The turns of every chat (a uuid per user message, the last assistant uuid per turn) and the links of forks: see turns.js.
	const stores = turnsLib.createStores({ fs: cfg.fs, dir: () => cfg.configDir });
	const history = createHistory({ loadSdk: () => loadSdk(), configDir: () => cfg.configDir, env: process.env, scrub: (t) => scrub(t) });

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

	// The last chosen permission mode: a first run (or an unreadable file) starts in "Ask before commands".
	function readLastMode() {
		try {
			if (!cfg.configDir) return logic.DEFAULT_MODE;
			return logic.parseLastMode(cfg.fs.readFileSync(path.join(cfg.configDir, MODE_FILE), "utf8"));
		} catch {
			return logic.DEFAULT_MODE;
		}
	}
	function writeLastMode(mode) {
		try {
			if (!cfg.configDir) return;
			cfg.fs.mkdirSync(cfg.configDir, { recursive: true });
			cfg.fs.writeFileSync(path.join(cfg.configDir, MODE_FILE), JSON.stringify({ mode }) + "\n", { mode: 0o600 });
		} catch {}
	}
	// The status record the mode selector reads (the same one Pi's permission extension sends): only sent once the gate is installed.
	const modeStatus = (h) => status.statusRecord(logic.STATUS_KEY, logic.statusText(h.mode));

	// The SDK-side mode follows the chat's mode; every mode is "default" (permissions.js), so a switch never changes what the SDK skips.
	const liveSdkMode = (h, mode) => sdkModeFor(mode).permissionMode;

	// "/crust-mode <id>": the selector's request. The gate's mode changes (grants are cleared, as in Pi), the SDK's mode follows, the choice
	// is remembered, and the status goes out: the selector moves only on that status.
	async function switchMode(h, record) {
		const reply = (success, extra) => {
			if (record.id !== undefined && !h.closed) h.sink.record(h, { type: "response", id: record.id, command: "prompt", success, ...extra });
		};
		const m = MODE_COMMAND.exec(String(record.message));
		const mode = m && m[1] ? logic.parseMode(m[1]) : null;
		if (!mode) return reply(false, { error: "Unknown permission mode. Use plan, ask-edits, ask-commands or trusted." });
		if (!h.query || !h.canUseTool || !h.gateInstalled) return reply(false, { error: "Claude Agent is not ready yet, so the mode cannot be changed." });
		try {
			if (typeof h.query.setPermissionMode === "function") await h.query.setPermissionMode(liveSdkMode(h, mode));
		} catch {
			return reply(false, { error: "Claude Agent did not take the mode switch, so the mode is unchanged." });
		}
		if (h.closed) return;
		h.mode = mode;
		logic.clearGrants(h.canUseTool.grants);
		writeLastMode(mode);
		emit(h, [modeStatus(h)]);
		reply(true, { data: { disposition: "handled" } });
	}

	// opts: { cwd, env?, settings?, sessionRef?, fork?, mode?, ask? }. Returns the handle at once; readiness and failures come through the sink.
	// fork: { from, at, view, turns, parent, title } is a chat that goes on from a copy of another session (forkSpec below): resume `from` with
	// forkSession, cut at the assistant uuid `at` (none = the whole session); `from` null = a fresh session. Until its first message the chat
	// has no session of its own: pendingFork says which part of the old one it shows.
	// The trial log (src/trial.js, only when its unpackaged-only switch is set): cfg.trial is null otherwise. It never throws into the chat.
	let chatNo = 0;
	const gateTrace = (ev) => {
		try {
			const t = cfg.trial;
			if (t) (ev.phase === "hook" ? t.hook : t.final)(ev);
		} catch {}
	};
	function start(opts, sink) {
		const mode0 = logic.isMode(opts.mode) ? opts.mode : readLastMode();
		const handle = { pid: undefined, exitCode: null, signalCode: null, query: null, input: inputQueue(), child: null, closed: false, exitCbs: [], sink, mode: mode0, gateInstalled: false, gen: 0, rebuild: null, turns: [], turnsLoading: null, pendingFork: null, forkInfo: null };
		// What the adapter knows about this chat: its own translator, usage totals, the model and effort in force.
		handle.translator = createTranslator({ now: cfg.now });
		handle.track = status.newTrack();
		handle.meta = { cwd: opts.cwd, sessionId: opts.sessionRef || null, modelId: null, chosen: false, effort: null, streaming: false, lastAssistantText: null, commands: [], permissionMode: null, lastContext: null };
		handle.limits = {};
		handle.traceNo = ++chatNo;
		const fk = opts.fork && typeof opts.fork === "object" ? opts.fork : null;
		if (fk) {
			handle.turns = (Array.isArray(fk.turns) ? fk.turns : []).map(turnsLib.cleanTurn).filter(Boolean);
			handle.pendingFork = { from: typeof fk.from === "string" && fk.from ? fk.from : null, view: fk.view || "none", at: typeof fk.at === "string" && fk.at ? fk.at : null };
			handle.forkInfo = { parent: typeof fk.parent === "string" ? fk.parent : null, at: handle.pendingFork.at, title: typeof fk.title === "string" ? fk.title : null };
		} else if (opts.sessionRef) {
			// A restored chat: its turns come back from the store; a session without one (an older chat) is read from the SDK's history.
			const stored = stores.loadTurns(opts.sessionRef);
			if (stored) handle.turns = stored;
			else
				handle.turnsLoading = history
					.loadRows(opts.sessionRef, { cwd: opts.cwd })
					.then((rows) => {
						handle.turns = [...turnsLib.turnsFromRows(rows), ...handle.turns];
					})
					.catch(() => {});
		}
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
		let key = null;
		const failure = (e) => {
			if (handle.closed) finish({ kind: "exit", code: null, signal: "SIGTERM" });
			else finish({ kind: "error", error: scrub(e && e.message ? e.message : e, key) });
		};
		(async () => {
			try {
				if (!cfg.configDir) return finish({ kind: "error", error: NO_CONFIG_DIR, errorCode: "NO_CONFIG_DIR" });
				const k = cfg.keystore ? await cfg.keystore.read() : { key: null };
				key = k && k.key;
				handle.key = key || null;
				if (!key) return finish({ kind: "error", error: (k && k.reason) || NO_KEY, errorCode: "NO_KEY" });
				const sdk = await loadSdk();
				if (handle.closed) return finish({ kind: "exit", code: null, signal: "SIGTERM" });
				const canUseTool = makeCanUseTool({
					getMode: () => handle.mode,
					// The prompt shows what the agent wants to run, and that text can hold the key: it is scrubbed before anyone sees it.
					ask: (prompt, meta) => {
						const shown = prompt ? scrubDeep(prompt, handle.key) : prompt;
						return typeof opts.ask === "function" ? opts.ask(shown, meta) : sink.ask ? sink.ask(handle, shown, meta) : undefined;
					},
					cwd: opts.cwd,
					trace: gateTrace,
				});
				handle.canUseTool = canUseTool;
				// The gate sits in a PreToolUse hook (it sees every call, subagents and reads inside the project too): it denies what the rules
				// block and sends everything else to canUseTool, the only place that allows. The mode is this chat's, never the hook input's.
				const hooks = makeHooks({ getMode: () => handle.mode, grants: canUseTool.grants, cwd: opts.cwd, trace: gateTrace });
				const lim = opts.settings || cfg.getSettings() || {};
				handle.limits = { budgetUsd: num(lim.claudeMaxBudgetUsd, DEFAULT_MAX_BUDGET_USD), maxTurns: Math.floor(num(lim.claudeMaxTurns, DEFAULT_MAX_TURNS)) };
				// One query; a rewind in the chat's own tab runs a second one on the same handle (the first is closed and its loop drops out).
				// qx: { resume, fork, at } = go on from another session (resume it, fork it, cut after the assistant uuid `at`); resume null = a fresh session.
				const runQuery = async (qx, onReady) => {
					const gen = ++handle.gen;
					try {
						const extra = {
							canUseTool,
							hooks,
							// The stream echoes each user message with the uuid we gave it (capture-rewind L10); the translator ignores the echo.
							extraArgs: { "replay-user-messages": null },
							// Lets stop() tree-kill the engine process (the SDK does not give us its pid otherwise).
							spawnClaudeCodeProcess: (so) => {
								const child = require("node:child_process").spawn(so.command, so.args, { cwd: so.cwd, env: so.env, stdio: ["pipe", "pipe", "ignore"], windowsHide: true, signal: so.signal });
								handle.child = child;
								handle.pid = child.pid;
								return child;
							},
						};
						if (qx.fork) {
							extra.forkSession = true;
							if (qx.at) extra.resumeSessionAt = qx.at;
						}
						const options = buildOptions({ ...opts, mode: handle.mode, sessionRef: qx.resume !== undefined ? qx.resume : opts.sessionRef }, key, extra);
						const q = sdk.query({ prompt: handle.input, options });
						handle.query = q;
						if (handle.closed) {
							closeQuery(handle);
							return "closed";
						}
						// Both the hook and the approval callback went into the query: only now is the mode enforced, so only now it is reported.
						handle.gateInstalled = true;
						emit(handle, [modeStatus(handle)]);
						const init = typeof q.initializationResult === "function" ? await q.initializationResult() : {};
						if (gen !== handle.gen) return "superseded";
						if (init && Array.isArray(init.commands)) handle.meta.commands = init.commands;
						onReady(init || {});
						for await (const message of q) {
							if (gen !== handle.gen) return "superseded";
							if (sink.isCurrent && !sink.isCurrent(handle)) continue;
							observe(handle, message);
							if (message && message.type === "system" && message.subtype === "init" && cfg.trial) {
								try {
									cfg.trial.chatStart(handle.traceNo, { ...message, agents: Array.isArray(message.agents) ? message.agents : init && init.agents }, handle.mode, gen > 1);
								} catch {}
							}
							emit(handle, handle.translator.push(message));
							if (message && message.type === "result") await afterResult(handle, message);
						}
						return gen === handle.gen ? "ended" : "superseded";
					} catch (e) {
						if (gen !== handle.gen) return "superseded";
						throw e;
					}
				};
				handle.rebuild = (qx) =>
					new Promise((resolve, reject) => {
						let ready = false;
						handle.gen++; // the running loop drops out; nothing it still holds reaches the sink
						try {
							handle.input.end();
						} catch {}
						const old = handle.query;
						handle.input = inputQueue();
						try {
							if (old && typeof old.close === "function") old.close();
						} catch {}
						runQuery(qx, () => {
							ready = true;
							resolve();
						}).then(
							(how) => {
								if (how === "superseded") return;
								if (!ready) {
									failure(new Error("Claude Agent stopped while the conversation was being rewound."));
									return reject(new Error("Claude Agent stopped while the conversation was being rewound."));
								}
								if (how === "ended") finish({ kind: "exit", code: 0, signal: null });
							},
							(e) => {
								failure(e);
								if (!ready) reject(e);
							},
						);
					});
				const first = fk ? { resume: handle.pendingFork.from, fork: !!handle.pendingFork.from, at: handle.pendingFork.at } : {};
				const how = await runQuery(first, (init) => {
					if (!sink.isCurrent || sink.isCurrent(handle)) sink.ready(handle, scrubDeep(init, handle.key));
				});
				if (how === "closed") return finish({ kind: "exit", code: null, signal: "SIGTERM" });
				if (how === "ended") finish({ kind: "exit", code: 0, signal: null });
			} catch (e) {
				failure(e);
			}
		})();
		return handle;
	}

	// The assistant uuid that ends a turn (resumeSessionAt takes it). The SDK's assistant messages name the user message they answer;
	// without that field the newest turn is meant.
	function observe(h, m) {
		if (!m || m.type !== "assistant" || m.parent_tool_use_id || typeof m.uuid !== "string" || !m.uuid || !h.turns.length) return;
		const turn = (typeof m.user_message_uuid === "string" && h.turns.find((t) => t.uuid === m.user_message_uuid)) || h.turns[h.turns.length - 1];
		turn.assistantUuid = m.uuid;
	}
	const persist = (h) => {
		if (h.meta.sessionId) stores.saveTurns(h.meta.sessionId, h.turns);
	};
	async function turnsOf(h) {
		if (h.turnsLoading) await h.turnsLoading;
		return h.turns;
	}
	// Where this chat stands in the SDK's world: its own session, or (after a rewind or fork, until the next message creates a session) the
	// cut of an older one. view: "all", "none" or the assistant uuid the cut ends at.
	const standing = (h) => (h.pendingFork ? { ...h.pendingFork } : { from: h.meta.sessionId, view: "all", at: null });

	// Rewind and "edit and resend" in the chat's own tab: the conversation goes back to before the user message `entryId` (its uuid). The SDK
	// continues a copy of the session cut after the previous turn's last assistant message (forkSession + resumeSessionAt); before the first
	// message there is nothing to keep, so a fresh session starts. Returns { ok, text } (the message's text) or { ok:false, error }.
	async function forkInPlace(h, entryId) {
		if (!h.rebuild || !h.query || h.closed) return { ok: false, error: "Claude Agent is not ready yet." };
		if (h.meta.streaming) return { ok: false, error: "Claude Agent is still working. Stop it first." };
		const p = turnsLib.plan(await turnsOf(h), entryId);
		if (!p.ok) return p;
		const from = standing(h).from;
		if (p.at && !from) return { ok: false, error: "This chat has no saved session yet, so it cannot go back." };
		const was = { pendingFork: h.pendingFork, turns: h.turns, sessionId: h.meta.sessionId };
		h.pendingFork = { from, view: p.at || "none", at: p.at };
		h.turns = p.keep.slice();
		h.meta.sessionId = null;
		h.meta.streaming = false;
		h.meta.lastAssistantText = null;
		h.translator = createTranslator({ now: cfg.now });
		try {
			await h.rebuild(p.at ? { resume: from, fork: true, at: p.at } : { resume: null });
		} catch (e) {
			Object.assign(h, { pendingFork: was.pendingFork, turns: was.turns });
			h.meta.sessionId = was.sessionId;
			return { ok: false, error: scrub(e && e.message ? e.message : e, h.key) };
		}
		return { ok: true, text: p.text };
	}

	// What the app needs to open a fork in a NEW tab: { ok, text, start } where `start` goes to adapter.start as opts.fork. entryId = the
	// user message to fork before (its text comes back for the new chat's message box); null = the end of the chat. The new tab is named
	// "Fork of <title>" and the link to this chat is stored when the fork's own session appears (its first message).
	async function forkSpec(h, { entryId = null, title = "" } = {}) {
		if (!h || h.closed) return { ok: false, error: "Claude Agent is not running." };
		const p = turnsLib.plan(await turnsOf(h), entryId === undefined ? null : entryId);
		if (!p.ok) return p;
		const at = standing(h);
		let start;
		if (p.end) start = { from: at.view === "none" ? null : at.from, at: at.at, view: at.view, turns: p.keep, parent: at.from };
		else start = { from: p.keep.length ? at.from : null, at: p.at, view: p.at || "none", turns: p.keep, parent: at.from };
		if (start.from === null && start.view !== "none") return { ok: false, error: "This chat has no saved session yet, so it cannot be forked." };
		return { ok: true, text: p.text, start: { ...start, title: turnsLib.forkTitle(title) } };
	}

	// Records to the sink, remembering what the requests need (session, model, streaming, last answer text).
	function emit(h, records) {
		for (const r of records) {
			const m = h.meta;
			if (r.type === "claude_session") {
				if (h.pendingFork && r.sessionId && r.sessionId !== h.pendingFork.from) {
					// The chat's own session exists now (a rewound or forked chat sent its first message): the cut of the old one is history.
					h.pendingFork = null;
					if (h.forkInfo && h.forkInfo.parent) stores.linkFork(r.sessionId, h.forkInfo);
				}
				m.sessionId = r.sessionId || m.sessionId;
				if (r.sessionId) stores.saveTurns(r.sessionId, h.turns);
				if (!m.chosen && r.model) m.modelId = r.model;
				if (r.permissionMode) m.permissionMode = r.permissionMode;
				if (typeof r.skillCount === "number") h.track.skillCount = r.skillCount;
			} else if (r.type === "agent_start") m.streaming = true;
			else if (r.type === "agent_settled") m.streaming = false;
			else if (r.type === "message_end" && r.message && r.message.role === "assistant" && r.message.stopReason !== "error") {
				const text = (r.message.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
				if (text) m.lastAssistantText = scrub(text, h.key);
			}
			h.sink.record(h, scrubDeep(r, h.key));
		}
	}

	// After every result: the cost and the context meter (getContextUsage, the only live source), and the pause event for a limit stop.
	async function afterResult(h, result) {
		persist(h);
		status.trackUsage(h.track, result);
		let usage = null;
		try {
			if (h.query && typeof h.query.getContextUsage === "function") usage = await h.query.getContextUsage();
		} catch {}
		if (usage) h.meta.lastContext = usage;
		const ctx = status.contextStatus(usage || h.meta.lastContext, h.track);
		if (ctx && !(h.sink.isCurrent && !h.sink.isCurrent(h))) h.sink.record(h, scrubDeep(status.statusRecord(status.CONTEXT_STATUS_KEY, ctx), h.key));
		const pause = status.pauseEvent(result, h.limits);
		if (pause) h.sink.record(h, scrubDeep(pause, h.key));
	}

	const canSend = (h) => !!h && !h.closed && h.input.open && h.exitCode === null && h.signalCode === null;
	const state = (h) => ({ pid: h.pid, exitCode: h.exitCode, signalCode: h.signalCode });
	const onceExit = (h, cb) => (h.exitCode !== null || h.signalCode !== null ? cb() : h.exitCbs.push(cb));

	// uuid: the id this message gets in the SDK's transcript (the stream echoes it; rewind and fork cut at it).
	function userMessage(r, uuid) {
		const content = [{ type: "text", text: String(r.message == null ? "" : r.message) }];
		for (const im of Array.isArray(r.images) ? r.images : []) if (im && im.data) content.push({ type: "image", source: { type: "base64", media_type: im.mimeType || "image/png", data: im.data } });
		return { type: "user", message: { role: "user", content }, parent_tool_use_id: null, uuid };
	}

	const answerCtx = (h) => ({
		// A rewound or forked chat has no session of its own until its next message: no session file is reported before that.
		state: () => ({ ...h.meta, sessionId: h.pendingFork ? null : h.meta.sessionId, sessionName: ((h.meta.sessionId && stores.forkOf(h.meta.sessionId)) || h.forkInfo || {}).title || null }),
		patch: (p) => {
			if (p.modelId) {
				h.meta.modelId = p.modelId;
				h.meta.chosen = true;
			}
			if (p.effort) h.meta.effort = p.effort;
		},
		query: h.query,
		messages: () => {
			const p = h.pendingFork;
			if (!p) return history.loadMessages(h.meta.sessionId, { cwd: h.meta.cwd });
			return history.loadMessages(p.from, { cwd: h.meta.cwd, ...(p.view === "all" ? {} : { upTo: p.view === "none" ? null : p.view }) });
		},
		forkMessages: async () => turnsLib.forkMessages(await turnsOf(h)),
		fork: (entryId) => forkInPlace(h, entryId),
		scrub: (t) => scrub(t, h.key),
	});

	// Pi-shaped requests in. A prompt feeds the input stream and its row is emitted here (the stream never echoes it); the rest is
	// answered by requests.js. Every request with an id gets a response record.
	function send(h, record) {
		if (!canSend(h) || !record) return false;
		if (record.type === "prompt" && MODE_COMMAND.test(String(record.message == null ? "" : record.message))) {
			switchMode(h, record);
			return true;
		}
		if (record.type === "prompt") {
			const slash = SLASH_START.exec(String(record.message == null ? "" : record.message));
			if (slash && !SLASH_ALLOW.includes(slash[1])) {
				// The SDK would run this command itself (/add-dir, /plugin, /mcp, /hooks, /permissions, /config, /login ...): it never gets it.
				if (record.id !== undefined) h.sink.record(h, { type: "response", id: record.id, command: "prompt", success: false, error: `/${slash[1].slice(0, 40)} is not available in Claude Agent chats.` });
				return true;
			}
			const text = String(record.message == null ? "" : record.message);
			const images = Array.isArray(record.images) ? record.images.filter((im) => im && im.data).map((im) => ({ data: im.data, mimeType: im.mimeType || "image/png" })) : [];
			const uuid = cfg.uuid();
			if (!h.input.push(userMessage(record, uuid))) return false;
			h.turns.push({ uuid, text, at: cfg.now(), assistantUuid: null });
			persist(h);
			emit(h, h.translator.userMessage({ text, images, uuid }));
			if (record.id !== undefined) h.sink.record(h, { type: "response", id: record.id, command: "prompt", success: true });
			return true;
		}
		Promise.resolve(requests.answer(record, answerCtx(h))).then(
			(resp) => {
				if (resp && record.id !== undefined && !h.closed) h.sink.record(h, scrubDeep(resp, h.key)); // a history or an error can carry the key
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
			const options = buildOptions({ cwd: cfg.configDir || process.cwd(), claudeMd: false }, key, { maxTurns: 1, maxBudgetUsd: 0.05, tools: [], thinking: { type: "disabled" }, canUseTool: async () => ({ behavior: "deny", message: "No tools in a key check." }) });
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
		// The SDK gives every fork the title of its parent: the app's own "Fork of ..." name replaces it.
		listSessions: async (opts) =>
			(await history.listSessions(opts || {})).map((s) => {
				const f = stores.forkOf(s.path);
				return f && f.title ? { ...s, name: f.title, forkOf: f.parent } : s;
			}),
		forkSpec,
		forkOf: (sessionId) => stores.forkOf(sessionId),
		auth,
		mcpConfigPath: () => null,
		onAppStart: () => {},
		// The app hands over its pieces once it has them (userData folder, safeStorage, settings).
		configure(next = {}) {
			for (const k of ["keystore", "configDir", "getSettings", "isPackaged", "loadSdk", "killTree", "enginePath", "trial"]) if (next[k] !== undefined) cfg[k] = next[k];
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
module.exports.scrubDeep = scrubDeep;
module.exports.SLASH_ALLOW = SLASH_ALLOW;
