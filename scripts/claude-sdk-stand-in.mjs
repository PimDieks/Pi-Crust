// Stand-in for @anthropic-ai/claude-agent-sdk (tests and offscreen runs only; PI_CRUST_CLAUDE_SDK=<this file>, unpackaged app only).
// query({ prompt, options }) replays scripted messages after the first user message and logs what it was given. The log never holds
// a key: options.env is reduced to { ANTHROPIC_API_KEY: "key present" | "key absent", names: [...] }.
// Script: PI_CRUST_CLAUDE_SCRIPT=<json array, or a .jsonl fixture>, or setScript([...]) / setFixture(file, { awaitUser: [index...] }).
// A script entry { "__await_user": true } makes the replay wait for the next user message (a second prompt after an interrupt).
// Log: the exported `calls` (one entry per query: options, calls (strings), log (every SDK call as { fn, args }), interrupted, modes),
// `fnCalls` (listSessions / getSessionMessages / getSessionInfo, which are module functions), and PI_CRUST_CLAUDE_SDK_LOG=<file>.
// Answers: supportedModels, getContextUsage, supportedCommands, listSessions, getSessionMessages come from setModels(), setContextUsage(),
// setSessions(), setSessionMessages({ id: [...] }) (defaults are small, real-shaped, normalised).
import fs from "node:fs";

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

export function query({ prompt, options }) {
	const entry = { options: describeOptions(options), rawEnvHasKey: !!(options && options.env && options.env.ANTHROPIC_API_KEY), calls: [], log: [], closed: false, interrupted: 0, modes: [] };
	calls.push(entry);
	logFile({ options: entry.options });
	let stopWait = null;
	const logCall = (fn, ...args) => {
		entry.log.push({ fn, args });
		logFile({ fn, args });
	};
	async function* run() {
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
