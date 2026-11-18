// Remote access: the hub keeps a small per-chat summary from the same events the renderer gets (main's send() tap), so the
// phone list is right even if Remote is switched on later. slimRecord/slimMessage shrink Pi records before they go over
// the wire (no images, bounded tool output). Pure: no Electron, no I/O.
"use strict";

const SUMMARY_TEXT = 160;
const TEXT_CAP = 64 * 1024; // user/assistant text blocks
const TOOL_TEXT_CAP = 8 * 1024; // tool results and thinking
const ARG_CAP = 2 * 1024; // write/edit contents inside tool-call arguments
const UPDATE_TAIL = 2 * 1024; // streaming tool output: only the end matters
const UPDATE_EVERY_MS = 1000;
const DIALOGS = new Set(["select", "confirm", "input", "editor"]);
// The permission-modes extension's status text ("Mode: Trusted") -> mode id (mirrors MODE_LABELS in palette.js).
const MODE_BY_LABEL = { "Plan (read-only)": "plan", "Ask before edits": "ask-edits", "Ask before commands": "ask-commands", Trusted: "trusted" };
const stripAnsi = (s) => String(s ?? "").replace(/\x1b\[[0-9;]*m/g, "").trim();

// The "crust-context" status (src/pi-extension/crust-context.ts) -> { pct, approx } | null, like context-panel.js shows it.
function contextOf(raw) {
	let d;
	try {
		d = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!isObj(d) || !(d.window > 0)) return null;
	const c = isObj(d.categories) ? d.categories : {};
	const used = typeof d.total === "number" ? d.total : ["messages", "tools", "skills", "system", "memory"].reduce((s, k) => s + (Number(c[k]) || 0), 0);
	return { pct: Math.max(0, Math.min(100, Math.round((used / d.window) * 100))), approx: typeof d.total !== "number" };
}

const strings = (a) => (Array.isArray(a) ? a.filter((s) => typeof s === "string") : []);
const isObj = (x) => x && typeof x === "object" && !Array.isArray(x);

// Keep the start; say how much was cut.
function truncHead(s, max) {
	s = String(s ?? "");
	return s.length > max ? `${s.slice(0, max)}…[truncated ${s.length - max} chars]` : s;
}
function truncTail(s, max) {
	s = String(s ?? "");
	return s.length > max ? `…[truncated ${s.length - max} chars]\n${s.slice(-max)}` : s;
}

// Text of a message content (string or blocks).
function textOf(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b) => b && b.type === "text" && typeof b.text === "string")
		.map((b) => b.text)
		.join("\n");
}
const oneLine = (s) => String(s).replace(/\s+/g, " ").trim();

// Content blocks / string -> same shape with images omitted and text capped.
function slimContent(content, max = TOOL_TEXT_CAP, trunc = truncHead) {
	if (typeof content === "string") return trunc(content, max);
	if (!Array.isArray(content)) return content;
	return content.map((b) => {
		if (!isObj(b)) return b;
		if (b.type === "image") return { type: "image", mimeType: b.mimeType, omitted: true };
		if (b.type === "text") return { type: "text", text: trunc(b.text, max) };
		if (b.type === "thinking") return { type: "thinking", thinking: truncHead(b.thinking, TOOL_TEXT_CAP) };
		if (b.type === "toolCall") return { type: "toolCall", id: b.id, name: b.name, arguments: slimArgs(b.arguments) };
		return { type: b.type };
	});
}

// Big strings inside tool arguments (file contents of write/edit) are capped; short ones (path, command) stay whole.
function slimArgs(args) {
	if (!isObj(args)) return args;
	const out = {};
	for (const [k, v] of Object.entries(args)) out[k] = typeof v === "string" ? truncHead(v, ARG_CAP) : Array.isArray(v) || isObj(v) ? slimArgsDeep(v) : v;
	return out;
}
function slimArgsDeep(v) {
	if (typeof v === "string") return truncHead(v, ARG_CAP);
	if (Array.isArray(v)) return v.slice(0, 50).map(slimArgsDeep);
	if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, slimArgsDeep(x)]));
	return v;
}

// A tool result is { content: [...], details }: details can be huge (diffs, subagent runs) and the phone doesn't use it.
const slimResult = (r, max, trunc) => (isObj(r) ? { content: slimContent(r.content, max, trunc) } : r);

const MESSAGE_FIELDS = ["role", "timestamp", "stopReason", "errorMessage", "toolCallId", "toolName", "isError", "durationMs", "customType", "display", "summary"];

function slimMessage(m) {
	if (!isObj(m)) return m;
	const out = {};
	for (const k of MESSAGE_FIELDS) if (m[k] !== undefined) out[k] = m[k];
	const cap = m.role === "toolResult" ? TOOL_TEXT_CAP : TEXT_CAP;
	out.content = slimContent(m.content, cap);
	if (typeof out.summary === "string") out.summary = truncHead(out.summary, TOOL_TEXT_CAP);
	return out;
}

const size = (x) => Buffer.byteLength(JSON.stringify(x));

// Newest messages win when the history is too big for one response.
function slimMessages(list, maxBytes = 1_500_000) {
	const slim = (Array.isArray(list) ? list : []).map(slimMessage);
	let total = 2;
	let from = slim.length;
	while (from > 0) {
		const n = size(slim[from - 1]) + 1;
		if (total + n > maxBytes) break;
		total += n;
		from--;
	}
	return { messages: slim.slice(from), truncated: from > 0 };
}

function createThrottle(now = Date.now) {
	return { last: new Map(), now };
}
const defaultThrottle = createThrottle();

// Wire event types the phone renders. Everything else is dropped (deltas of tool calls/thinking, entries, UI requests, ...).
const UPDATE_TYPES = new Set(["text_delta", "text_end", "thinking_end", "toolcall_start", "toolcall_end", "error"]);

function slimUpdate(ev) {
	if (!isObj(ev) || !UPDATE_TYPES.has(ev.type)) return null;
	const out = { type: ev.type, contentIndex: ev.contentIndex };
	if (ev.type === "text_delta") out.delta = ev.delta;
	else if (ev.type === "text_end") out.content = truncHead(ev.content, TEXT_CAP);
	else if (ev.type === "thinking_end") out.content = truncHead(ev.content, TOOL_TEXT_CAP);
	else if (ev.type === "toolcall_start") {
		out.id = ev.id;
		out.toolName = ev.toolName;
	} else if (ev.type === "toolcall_end") {
		const t = ev.toolCall || {};
		out.toolCall = { id: t.id, name: t.name, arguments: slimArgs(t.arguments) };
	} else if (ev.type === "error") {
		out.reason = ev.reason;
		out.errorMessage = ev.error?.errorMessage;
	}
	return out;
}

function slimRecord(r, throttle = defaultThrottle) {
	if (!isObj(r)) return null;
	switch (r.type) {
		case "agent_start":
		case "agent_settled":
		case "compaction_start":
			return { ...pick(r, ["type", "aborted", "reason"]) };
		case "agent_end":
			return { type: "agent_end", willRetry: r.willRetry };
		case "queue_update":
			return { type: "queue_update", steering: r.steering || [], followUp: r.followUp || [] };
		case "message_start":
		case "message_end":
			return { type: r.type, message: slimMessage(r.message) };
		case "message_update": {
			const ev = slimUpdate(r.assistantMessageEvent);
			return ev ? { type: "message_update", assistantMessageEvent: ev } : null;
		}
		case "tool_execution_start":
			return { type: r.type, toolCallId: r.toolCallId, toolName: r.toolName, args: slimArgs(r.args) };
		case "tool_execution_update": {
			const t = throttle.now();
			const last = throttle.last.get(r.toolCallId);
			if (last !== undefined && t - last < UPDATE_EVERY_MS) return null;
			if (throttle.last.size > 500) throttle.last.clear();
			throttle.last.set(r.toolCallId, t);
			return { type: r.type, toolCallId: r.toolCallId, toolName: r.toolName, args: slimArgs(r.args), partialResult: slimResult(r.partialResult, UPDATE_TAIL, truncTail) };
		}
		case "tool_execution_end":
			throttle.last.delete(r.toolCallId);
			return { type: r.type, toolCallId: r.toolCallId, toolName: r.toolName, args: slimArgs(r.args), result: slimResult(r.result, TOOL_TEXT_CAP, truncHead), isError: !!r.isError, durationMs: r.durationMs };
		case "compaction_end":
			// The phone only needs to know whether it worked (renderer.js: r.result ? ... : aborted / errorMessage).
			return { type: r.type, result: r.result ? true : null, aborted: r.aborted, errorMessage: r.errorMessage };
		case "auto_retry_start":
			return { ...pick(r, ["type", "attempt", "maxAttempts", "errorMessage"]) };
		case "session_info_changed":
			return { type: r.type, name: r.name };
		default:
			return null;
	}
}

function pick(o, keys) {
	const out = {};
	for (const k of keys) if (o[k] !== undefined) out[k] = o[k];
	return out;
}

// The part of an extension_ui_request the phone needs.
function slimRequest(req, expiresAt) {
	const out = pick(req, ["id", "method", "title", "message", "options", "placeholder", "prefill", "timeout"]);
	if (typeof out.title === "string") out.title = truncHead(out.title, Array.isArray(req.options) && req.options.includes("Allow once") ? 30000 : 1500); // an approval shows ALL of what is approved (up to 20,000 characters)
	if (typeof out.message === "string") out.message = truncHead(out.message, 4000);
	if (typeof out.prefill === "string") out.prefill = truncHead(out.prefill, 32 * 1024);
	if (Array.isArray(out.options)) out.options = out.options.slice(0, 50).map((o) => truncHead(typeof o === "string" ? o : (o?.label ?? o?.value ?? JSON.stringify(o)), 300));
	if (expiresAt) out.expiresAt = expiresAt;
	return out;
}

function createHub({ now = Date.now } = {}) {
	let repo = null;
	const chats = new Map();

	function upsert(id) {
		let c = chats.get(id);
		if (!c) {
			c = { id, title: "", cwd: null, branch: null, missingWorktree: null, sessionFile: null, ready: false, dead: false, streaming: false, asks: new Map(), lastText: "", updatedAt: now(), aborted: false, mode: null, ctx: null, since: 0, queue: { steering: [], followUp: [] }, held: [] };
			chats.set(id, c);
		}
		return c;
	}

	const liveAsks = (c) => [...c.asks.values()].filter((a) => !a.expiresAt || a.expiresAt > now());

	function summarize(c) {
		const asking = liveAsks(c).length;
		const status = c.dead ? "stopped" : asking ? "waiting" : c.streaming ? "working" : c.ready ? "idle" : "starting";
		return { id: c.id, title: c.title, cwd: c.cwd, branch: c.branch, status, asking, lastText: c.lastText.slice(0, SUMMARY_TEXT), updatedAt: c.updatedAt, mode: c.mode, ctx: c.ctx, since: c.streaming ? c.since : 0 };
	}
	// "chat" events are emitted only when something visible changed. updatedAt (activity: sorting, "done") doesn't move for
	// the permission mode or the context fill alone.
	const key = (c) => {
		const { mode, ctx, updatedAt, ...core } = summarize(c);
		return JSON.stringify([core, mode, ctx]);
	};
	const coreOf = (k) => (k === null ? null : JSON.stringify(JSON.parse(k)[0]));
	function changed(c, before, out) {
		const k = key(c);
		if (before !== null && k === before) return;
		if (before === null || coreOf(k) !== coreOf(before)) c.updatedAt = now();
		out.push({ sse: ["chat", { chat: summarize(c) }] });
	}

	const titleOf = (c) => c.title || "Chat";

	function onRecord(c, r, out) {
		switch (r.type) {
			case "agent_start":
				if (!c.streaming) c.since = now();
				c.streaming = true;
				break;
			case "agent_settled": {
				c.streaming = false;
				const aborted = !!r.aborted || c.aborted;
				c.aborted = false;
				if (!aborted) out.push({ push: { kind: "done", chatId: c.id, title: titleOf(c), body: c.lastText } });
				break;
			}
			case "queue_update":
				// Not part of the summary: no chat event, no updatedAt. The phone gets the record itself.
				c.queue = { steering: strings(r.steering), followUp: strings(r.followUp) };
				break;
			case "message_start":
				if (r.message?.role === "user" && !c.title) {
					const t = oneLine(textOf(r.message.content)).slice(0, 60);
					if (t) c.title = t;
				}
				break;
			case "message_end":
				if (r.message?.role === "assistant") {
					const t = oneLine(textOf(r.message.content));
					if (t) c.lastText = t;
					if (r.message.stopReason === "aborted") c.aborted = true;
				}
				break;
			case "session_info_changed":
				c.title = typeof r.name === "string" ? r.name : "";
				break;
			case "extension_ui_request":
				if (DIALOGS.has(r.method) && typeof r.id === "string") {
					const expiresAt = typeof r.timeout === "number" && r.timeout > 0 ? now() + r.timeout : 0;
					c.asks.set(r.id, { ...r, expiresAt });
					out.push({ sse: ["ui_request", { chatId: c.id, request: slimRequest(r, expiresAt) }] });
					out.push({ push: { kind: "ask", chatId: c.id, title: titleOf(c), body: String(r.title || r.message || "Pi has a question") } });
				} else if (r.method === "setStatus" && r.statusKey === "permission-mode") {
					const label = stripAnsi(r.statusText).replace(/^Mode:\s*/, "");
					c.mode = label ? MODE_BY_LABEL[label] || null : null;
				} else if (r.method === "setStatus" && r.statusKey === "crust-context") {
					c.ctx = r.statusText ? contextOf(r.statusText) : null;
				} else if (r.method === "notify") {
					out.push({ sse: ["toast", { chatId: c.id, message: String(r.message ?? ""), kind: r.notifyType || "info" }] });
				}
				break;
		}
	}

	function apply(channel, p) {
		const out = [];
		if (channel === "repo:changed") {
			reset(p?.repo);
			return [{ sse: ["reset", { repo, chats: [] }] }];
		}
		if (!isObj(p) || typeof p.chatId !== "string") return out;
		const known = chats.has(p.chatId);
		const c = upsert(p.chatId);
		const before = known ? key(c) : null;
		switch (channel) {
			case "pi:started":
				// A new process: old questions can't be answered any more.
				c.asks.clear();
				c.streaming = false;
				c.dead = false;
				c.ready = false;
				c.aborted = false;
				c.queue = { steering: [], followUp: [] }; // Pi's queue died with the old process; held messages live in main
				c.mode = null; // the new process's extensions report these again
				c.ctx = null;
				c.cwd = typeof p.cwd === "string" ? p.cwd : c.cwd;
				c.branch = p.worktree?.branch ?? null;
				c.missingWorktree = p.missingWorktree || null;
				c.sessionFile = p.sessionFile || c.sessionFile;
				break;
			case "pi:ready":
				c.ready = true;
				c.dead = false;
				c.sessionFile = p.sessionFile || c.sessionFile;
				if (!c.title && typeof p.sessionName === "string") c.title = p.sessionName;
				break;
			case "pi:exit":
				c.dead = true;
				c.streaming = false;
				c.asks.clear();
				c.queue = { steering: [], followUp: [] };
				break;
			case "pi:held":
				// Messages paused by Stop (held-queue.js). Not part of the summary either.
				c.held = strings(p.held);
				out.push({ sse: ["held", { chatId: c.id, held: c.held }] });
				break;
			case "pi:uiResolved":
				c.asks.delete(p.id);
				out.push({ sse: ["ui_resolved", { chatId: c.id, id: p.id, by: p.by }] });
				break;
			case "pi:record":
				// Records from a chat we never saw start (Remote enabled mid-run): it is running.
				if (!known) c.ready = true;
				if (isObj(p.record)) onRecord(c, p.record, out);
				break;
			default:
				if (!known) chats.delete(c.id);
				return out;
		}
		changed(c, before, out);
		return out;
	}

	function reset(newRepo) {
		repo = newRepo ?? null;
		chats.clear();
	}

	return {
		reset,
		apply,
		repo: () => repo,
		list: () => [...chats.values()].map(summarize).sort((a, b) => b.updatedAt - a.updatedAt),
		summary: (id) => (chats.has(id) ? summarize(chats.get(id)) : null),
		asks: (id) => (chats.has(id) ? liveAsks(chats.get(id)).map((a) => slimRequest(a, a.expiresAt)) : []),
		queue: (id) => (chats.has(id) ? chats.get(id).queue : { steering: [], followUp: [] }),
		held: (id) => (chats.has(id) ? [...chats.get(id).held] : []),
		setTitle(id, t) {
			const c = chats.get(id);
			if (!c || !t) return [];
			const before = key(c);
			c.title = String(t).slice(0, 60);
			const out = [];
			changed(c, before, out);
			return out;
		},
		drop: (id) => chats.delete(id),
	};
}

module.exports = { createHub, createThrottle, slimRecord, slimMessage, slimMessages, slimContent };
