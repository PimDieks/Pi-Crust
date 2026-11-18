// Stand-in for @anthropic-ai/claude-agent-sdk (tests and offscreen runs only; PI_CRUST_CLAUDE_SDK=<this file>, unpackaged app only).
// query({ prompt, options }) replays scripted messages after the first user message and logs what it was given. The log never holds
// a key: options.env is reduced to { ANTHROPIC_API_KEY: "key present" | "key absent", names: [...] }.
// Script: PI_CRUST_CLAUDE_SCRIPT=<json array, or a .jsonl fixture>, or setScript([...]) / setFixture(file, { awaitUser: [index...] }).
// A script entry { "__tool_call": { tool_name, tool_input, agent_id?, permission_mode? } } runs one tool call through the gate like the real SDK:
// every PreToolUse hook first (deny blocks; "ask" goes on to canUseTool; "allow" skips it; a hook that throws blocks only when its matcher says
// onFailure "block", else the call goes on); with no hook decision the SDK approves the Agent tool and a Read inside cwd by itself and sends
// the rest to canUseTool. Every call is logged in the entry's `gates` as { call, hooks, viaCanUseTool, outcome }.
// A script entry { "__await_user": true } makes the replay wait for the next user message (a second prompt after an interrupt).
// Log: the exported `calls` (one entry per query: options, calls (strings), log (every SDK call as { fn, args }), interrupted, modes),
// `fnCalls` (listSessions / getSessionMessages / getSessionInfo, which are module functions), and PI_CRUST_CLAUDE_SDK_LOG=<file>.
// Answers: supportedModels, getContextUsage, supportedCommands, listSessions, getSessionMessages come from setModels(), setContextUsage(),
// setSessions(), setSessionMessages({ id: [...] }) (defaults are small, real-shaped, normalised).
import fs from "node:fs";
import path from "node:path";

export const calls = [];
export const fnCalls = [];
let script = null;
let models = null;
let contextUsage = null;
let sessions = null;
let sessionMessages = {};
export function setScript(s) {
	script = s;
}
export function setModels(m) {
	models = m;
}
export function setContextUsage(u) {
	contextUsage = u;
}
export function setSessions(s) {
	sessions = s;
}
export function setSessionMessages(m) {
	sessionMessages = m;
}
export function reset() {
	calls.length = 0;
	fnCalls.length = 0;
	script = null;
	models = null;
	contextUsage = null;
	sessions = null;
	sessionMessages = {};
}

// A recorded fixture (one JSON message per line) as a script. awaitUser: indexes (into the fixture's messages) that start a new turn
// only after the next user message, e.g. the repeated init after an interrupt.
export function fixtureScript(file, { awaitUser = [] } = {}) {
	const msgs = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
	const out = [];
	msgs.forEach((m, i) => {
		if (awaitUser.includes(i)) out.push({ __await_user: true });
		out.push(m);
	});
	return out;
}
export function setFixture(file, opts) {
	script = fixtureScript(file, opts);
}

const DEFAULT_SCRIPT = [
	{ type: "system", subtype: "init", session_id: "stand-in-session" },
	{ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "ok" } } },
	{ type: "result", subtype: "success", is_error: false, result: "ok", total_cost_usd: 0.01, session_id: "stand-in-session" },
];

const MODEL = (value, resolvedModel, displayName, extra = {}) => ({ value, resolvedModel, displayName, description: displayName, supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"], supportsAdaptiveThinking: true, supportsThinkingOff: false, ...extra });
const DEFAULT_MODELS = [MODEL("default", "claude-opus-5-5", "Default"), MODEL("sonnet", "claude-sonnet-5-5", "Sonnet"), MODEL("haiku", "claude-haiku-5-5", "Haiku", { supportsEffort: false, supportedEffortLevels: [] })];
const DEFAULT_CONTEXT = {
	categories: [
		{ id: "system_tools", name: "System tools", tokens: 2488, kind: "used" },
		{ id: "messages", name: "Messages", tokens: 886, kind: "used" },
		{ id: "autocompact_buffer", name: "Autocompact buffer", tokens: 33000, kind: "buffer" },
		{ id: "free_space", name: "Free space", tokens: 963626, kind: "free" },
	],
	totalTokens: 3374,
	maxTokens: 1000000,
	rawMaxTokens: 1000000,
	percentage: 0,
	model: "claude-haiku-5-5",
	memoryFiles: [],
	mcpTools: [],
};
const DEFAULT_SESSIONS = [{ sessionId: "stand-in-session", summary: "Notes summary", customTitle: "Notes summary", firstPrompt: "Read the file notes.txt.", lastModified: 1795009024441, fileSize: 34669, gitBranch: "HEAD", cwd: "C:\\work\\proj", createdAt: 1795009022268 }];

// The options as logged: functions by name, the env reduced to names and "key present".
export function describeOptions(o = {}) {
	const out = {};
	for (const [k, v] of Object.entries(o)) {
		if (k === "env") out.env = { ANTHROPIC_API_KEY: v && v.ANTHROPIC_API_KEY ? "key present" : "key absent", names: Object.keys(v || {}).sort(), CLAUDE_CONFIG_DIR: v && v.CLAUDE_CONFIG_DIR, CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: v && v.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB };
		else if (typeof v === "function") out[k] = "[function]";
		else if (k === "hooks" && v && typeof v === "object") out.hooks = Object.fromEntries(Object.entries(v).map(([ev, ms]) => [ev, (ms || []).map((m) => ({ matcher: m.matcher || null, hooks: (m.hooks || []).length, onFailure: m.onFailure || null }))]));
		else out[k] = v;
	}
	return out;
}

const logFile = (o) => process.env.PI_CRUST_CLAUDE_SDK_LOG && fs.appendFileSync(process.env.PI_CRUST_CLAUDE_SDK_LOG, JSON.stringify(o) + "\n");
// Module functions record the config folder they were called under: the real ones read it from the environment.
const fnCall = (fn, args) => {
	fnCalls.push({ fn, args, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR });
	logFile({ fn, args });
};
export async function listSessions(options = {}) {
	fnCall("listSessions", [options]);
	return sessions || DEFAULT_SESSIONS;
}
export async function getSessionInfo(id, options = {}) {
	fnCall("getSessionInfo", [id, options]);
	return (sessions || DEFAULT_SESSIONS).find((s) => s.sessionId === id);
}
export async function getSessionMessages(id, options = {}) {
	fnCall("getSessionMessages", [id, options]);
	return sessionMessages[id] || [];
}

function loadScript() {
	if (script) return script;
	const f = process.env.PI_CRUST_CLAUDE_SCRIPT;
	if (!f) return DEFAULT_SCRIPT;
	return f.endsWith(".jsonl") ? fixtureScript(f) : JSON.parse(fs.readFileSync(f, "utf8"));
}

// The real SDK's own approvals, seen in capture-hook-gate pass A: the Agent tool and reads inside the project never reach canUseTool.
const SDK_AUTO = (options, name, input) => {
	if (name === "Agent" || name === "Task") return true;
	const p = input && typeof input.file_path === "string" ? input.file_path : null;
	const cwd = options && options.cwd;
	return name === "Read" && !!p && !!cwd && path.resolve(cwd, p).toLowerCase().startsWith(path.resolve(cwd).toLowerCase() + path.sep);
};
export async function runGate(options, call) {
	const name = call.tool_name;
	const hookInput = { session_id: "stand-in-session", transcript_path: "", cwd: options && options.cwd, hook_event_name: "PreToolUse", tool_name: name, tool_input: call.tool_input, tool_use_id: call.tool_use_id || "toolu_stand_in", permission_mode: call.permission_mode || (options && options.permissionMode) || "default", ...(call.agent_id ? { agent_id: call.agent_id, agent_type: call.agent_type || "general-purpose" } : {}) };
	const entry = { call, hooks: [], viaCanUseTool: false };
	const matchers = (options && options.hooks && options.hooks.PreToolUse) || [];
	let hookAllow = false;
	for (const m of matchers) {
		if (m.matcher && !new RegExp("^(?:" + m.matcher + ")$").test(name)) continue;
		for (const h of m.hooks || []) {
			let out;
			try {
				out = await h(hookInput, hookInput.tool_use_id, { signal: new AbortController().signal });
			} catch (e) {
				entry.hooks.push({ threw: true });
				if (m.onFailure === "block") return { ...entry, outcome: "deny", reason: "hook failed" };
				continue;
			}
			const hs = out && out.hookSpecificOutput;
			const dec = hs && hs.permissionDecision;
			entry.hooks.push(dec || "none");
			if (dec === "deny") return { ...entry, outcome: "deny", reason: hs.permissionDecisionReason };
			if (dec === "allow") hookAllow = true;
			if (dec === "ask") entry.asked = true;
		}
	}
	if (hookAllow) return { ...entry, outcome: "allow" };
	if (!entry.asked && SDK_AUTO(options, name, call.tool_input)) return { ...entry, outcome: "allow", sdkAuto: true };
	entry.viaCanUseTool = true;
	const r = typeof options.canUseTool === "function" ? await options.canUseTool(name, call.tool_input, { signal: new AbortController().signal, toolUseID: hookInput.tool_use_id, ...(call.agent_id ? { agentID: call.agent_id } : {}) }) : { behavior: "deny" };
	return { ...entry, outcome: r && r.behavior === "allow" ? "allow" : "deny", result: r };
}

export const REJECTED_KEY = "sk-ant-test-rejected-0000";
export function query({ prompt, options }) {
	const entry = { gates: [], options: describeOptions(options), rawEnvHasKey: !!(options && options.env && options.env.ANTHROPIC_API_KEY), calls: [], log: [], closed: false, interrupted: 0, modes: [] };
	calls.push(entry);
	logFile({ options: entry.options });
	let stopWait = null;
	const logCall = (fn, ...args) => {
		entry.log.push({ fn, args });
		logFile({ fn, args });
	};
	async function* run() {
		// A key check (a string prompt) with this made-up key is answered like the API answers a wrong key: used by the setup self-test, no request goes anywhere.
		if (typeof prompt === "string" && options && options.env && options.env.ANTHROPIC_API_KEY === REJECTED_KEY) {
			yield { type: "result", subtype: "success", is_error: true, result: "Invalid API key - Fix external API key", session_id: "stand-in-session" };
			return;
		}
		const it = typeof prompt === "string" ? null : prompt[Symbol.asyncIterator]();
		const nextUser = async () => {
			const r = await Promise.race([it.next(), new Promise((res) => (stopWait = () => res({ done: true })))]);
			if (r.done || entry.closed) return false;
			entry.calls.push("user_message");
			return true;
		};
		if (it && !(await nextUser())) return;
		const messages = loadScript(); // read when the first prompt arrives, so a test can set the script after start
		for (const m of messages) {
			if (entry.closed) return;
			if (m && m.__await_user) {
				if (!it || !(await nextUser())) return;
				continue;
			}
			if (m && m.__tool_call) {
				entry.gates.push(await runGate(options, m.__tool_call));
				continue;
			}
			yield m;
		}
		// Streaming input stays open until closed, like the real one.
		if (it) await new Promise((r) => (stopWait = r));
	}
	const gen = run();
	gen.initializationResult = async () => (logCall("initializationResult"), { commands: [{ name: "compact", description: "Compact", argumentHint: "" }], models: models || DEFAULT_MODELS, account: {} });
	gen.interrupt = async () => (logCall("interrupt"), entry.interrupted++, { still_queued: [] });
	gen.setPermissionMode = async (m) => (logCall("setPermissionMode", m), void entry.modes.push(m));
	gen.setModel = async (m) => void logCall("setModel", m);
	gen.applyFlagSettings = async (s) => void logCall("applyFlagSettings", s);
	gen.supportedModels = async () => (logCall("supportedModels"), models || DEFAULT_MODELS);
	gen.supportedCommands = async () => (logCall("supportedCommands"), [{ name: "compact", description: "Compact the conversation", argumentHint: "" }]);
	gen.getContextUsage = async (o) => (logCall("getContextUsage", o), contextUsage || DEFAULT_CONTEXT);
	gen.close = () => {
		entry.closed = true;
		if (stopWait) stopWait();
	};
	return gen;
}
