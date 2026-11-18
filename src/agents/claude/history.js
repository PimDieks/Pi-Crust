// Claude sessions for the history picker and for redrawing a chat (phase 7, T8). Everything goes through the SDK's own functions
// (listSessions, getSessionMessages); this file never opens or parses the SDK's session files (their line format is internal).
//
// convertMessages is pure: SDK history rows -> the stored message shape the app's history uses (roles user, assistant,
// toolResult). The SDK's rows lack tool_use_result and live thinking text, so a stored Edit card has no structured diff.
//
// Where sessions live: the engine writes them under its CLAUDE_CONFIG_DIR, which the app sets for the child only. The SDK
// functions read the calling process's environment (they take no per-call option), so each call runs with CLAUDE_CONFIG_DIR set to
// the app's own folder: loaded first, set only around the call itself, restored after, one call at a time. A child spawned by
// something else while the SDK call is awaited could still inherit it; that window is the call, not the module load. With no app folder nothing is read: the user's own Claude sessions are never listed.
"use strict";

const { STOP_REASON, toolName, mapArgs, piBlocks, resultContent } = require("./translate");

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const INTERRUPT_TEXT = /^\[Request interrupted by user[^\]]*\]$/;
const ms = (t) => {
	const n = typeof t === "number" ? t : Date.parse(t);
	return Number.isFinite(n) ? n : undefined;
};

function userBlocks(content) {
	if (typeof content === "string") return content.trim() ? [{ type: "text", text: content }] : [];
	const out = [];
	for (const b of Array.isArray(content) ? content : []) {
		if (!isObj(b)) continue;
		if (b.type === "text" && typeof b.text === "string" && b.text.trim() && !INTERRUPT_TEXT.test(b.text.trim())) out.push({ type: "text", text: b.text });
		else if (b.type === "image" && isObj(b.source) && b.source.data) out.push({ type: "image", data: b.source.data, mimeType: b.source.media_type || "image/png" });
	}
	return out;
}

// SDK history rows (type user|assistant, message, parent_tool_use_id, timestamp) -> stored messages.
function convertMessages(rows) {
	const out = [];
	const calls = new Map(); // tool_use id -> { name (SDK), args, index of the Agent toolResult row when it has one }
	const inner = new Map(); // Agent tool_use id -> the subagent's messages
	let lastAssistant = null; // { id, msg } to merge the per-block rows of one API message
	for (const row of Array.isArray(rows) ? rows : []) {
		if (!isObj(row) || !isObj(row.message)) continue;
		const ts = ms(row.timestamp);
		const m = row.message;
		if (row.parent_tool_use_id) {
			const list = inner.get(row.parent_tool_use_id) || [];
			inner.set(row.parent_tool_use_id, list);
			if (row.type === "assistant") list.push({ role: "assistant", content: piBlocks(m.content), stopReason: "stop" });
			else
				for (const b of Array.isArray(m.content) ? m.content : [])
					if (isObj(b) && b.type === "tool_result") list.push({ role: "toolResult", toolCallId: b.tool_use_id, content: resultContent(b.content), isError: !!b.is_error });
			continue;
		}
		if (row.type === "assistant") {
			const content = piBlocks(m.content);
			const stopReason = STOP_REASON[m.stop_reason] || "stop";
			if (lastAssistant && m.id && lastAssistant.id === m.id) {
				lastAssistant.msg.content.push(...content);
				if (m.stop_reason) lastAssistant.msg.stopReason = stopReason;
			} else {
				const msg = { role: "assistant", content, stopReason };
				if (ts !== undefined) msg.timestamp = ts;
				out.push(msg);
				lastAssistant = { id: m.id, msg };
			}
			for (const b of Array.isArray(m.content) ? m.content : []) if (isObj(b) && b.type === "tool_use") calls.set(b.id, { name: b.name, args: mapArgs(b.name, b.input) });
			continue;
		}
		if (row.type !== "user") continue;
		lastAssistant = null;
		const blocks = Array.isArray(m.content) ? m.content : [];
		for (const b of blocks) {
			if (!isObj(b) || b.type !== "tool_result") continue;
			const c = calls.get(b.tool_use_id);
			const msg = { role: "toolResult", toolCallId: b.tool_use_id, toolName: c ? toolName(c.name) : "tool", content: resultContent(b.content), isError: !!b.is_error };
			if (ts !== undefined) msg.timestamp = ts;
			if (c && c.name === "Agent") {
				const msgs = inner.get(b.tool_use_id) || [];
				msg.details = { mode: "single", results: [{ agent: c.args.agent, task: c.args.task, exitCode: b.is_error ? 1 : 0, stopReason: "stop", usage: { turns: msgs.filter((x) => x.role === "assistant").length }, messages: msgs }] };
			}
			out.push(msg);
		}
		const content = userBlocks(m.content);
		if (content.length) {
			const msg = { role: "user", content };
			if (ts !== undefined) msg.timestamp = ts;
			if (typeof row.uuid === "string" && row.uuid) msg.uuid = row.uuid; // the id rewind and fork cut at (turns.js)
			out.push(msg);
		}
	}
	// Inner messages can come after the Agent's own result row (a background subagent): fill the card at the end.
	for (const msg of out) {
		if (msg.role === "toolResult" && msg.details && inner.has(msg.toolCallId)) {
			const r = msg.details.results[0];
			r.messages = inner.get(msg.toolCallId);
			r.usage = { turns: r.messages.filter((x) => x.role === "assistant").length };
		}
	}
	return out;
}

// The rows up to and including the one with this uuid (all of them when it is not found: never silently show less than was asked).
function cutRows(rows, uuid) {
	const i = rows.findIndex((r) => isObj(r) && r.uuid === uuid);
	return i < 0 ? rows : rows.slice(0, i + 1);
}

// The rows up to and including the one with this uuid (all of them when it is not found: never silently show less than was asked).
function cutRows(rows, uuid) {
	const i = rows.findIndex((r) => isObj(r) && r.uuid === uuid);
	return i < 0 ? rows : rows.slice(0, i + 1);
}

// SDKSessionInfo -> the history picker's item (same fields as Pi's, plus the agent tag). `path` is the session id: opaque to the app.
function sessionItem(s) {
	return {
		path: s.sessionId,
		name: s.customTitle || s.summary || null,
		firstPrompt: typeof s.firstPrompt === "string" ? s.firstPrompt.slice(0, 200) : null,
		mtime: typeof s.lastModified === "number" ? s.lastModified : 0,
		size: typeof s.fileSize === "number" ? s.fileSize : 0,
		cwd: s.cwd || null,
		branch: s.gitBranch && s.gitBranch !== "HEAD" ? s.gitBranch : null,
		agent: "claude",
	};
}

// deps: { loadSdk(): Promise<sdk>, configDir(): string|null, env: process.env-like (written to and restored) }
function createHistory(deps) {
	let chain = Promise.resolve();
	// One SDK call at a time, with CLAUDE_CONFIG_DIR pointing at the app's folder.
	function inConfigDir(fn) {
		const run = async () => {
			const dir = deps.configDir();
			if (!dir) return null;
			const sdk = await deps.loadSdk(); // before the variable is set: a slow import must not hold it
			const env = deps.env || process.env;
			const had = Object.prototype.hasOwnProperty.call(env, "CLAUDE_CONFIG_DIR");
			const old = env.CLAUDE_CONFIG_DIR;
			env.CLAUDE_CONFIG_DIR = dir;
			try {
				return await fn(sdk);
			} finally {
				if (had) env.CLAUDE_CONFIG_DIR = old;
				else delete env.CLAUDE_CONFIG_DIR;
			}
		};
		const p = chain.then(run, run);
		chain = p.catch(() => {});
		return p;
	}
	return {
		// { cwd } -> items, newest first, at most 60. Throws when the SDK does, with the key scrubbed: the caller (listAllSessions) keeps
		// the reason in its per-agent status so the session list can say why it is empty. No app folder is not an error: nothing is read.
		async listSessions({ cwd } = {}) {
			let list;
			try {
				list = await inConfigDir((sdk) => sdk.listSessions({ dir: cwd, limit: 60 }));
			} catch (e) {
				throw new Error("Claude sessions could not be listed: " + (deps.scrub ? deps.scrub(e && e.message ? e.message : e) : String((e && e.message) || e)));
			}
			return (Array.isArray(list) ? list : []).map(sessionItem).filter((s) => s.firstPrompt).sort((a, b) => b.mtime - a.mtime);
		},
		// A session's messages in the stored shape. Throws when the SDK does.
		// upTo: keep the rows up to and including the one with this uuid (a chat that was rewound or forked and has not sent its next message
		// yet: its new session does not exist, only the cut of the old one); null = none.
		async loadMessages(sessionId, { cwd, upTo } = {}) {
			if (!sessionId || upTo === null) return [];
			const rows = await inConfigDir((sdk) => sdk.getSessionMessages(String(sessionId), { dir: cwd }));
			return convertMessages(upTo === undefined ? rows || [] : cutRows(rows || [], upTo));
		},
		// The raw rows, for turns.js when a session has no stored turn list. Throws when the SDK does.
		async loadRows(sessionId, { cwd } = {}) {
			if (!sessionId) return [];
			return (await inConfigDir((sdk) => sdk.getSessionMessages(String(sessionId), { dir: cwd }))) || [];
		},
	};
}

module.exports = { createHistory, convertMessages, sessionItem };
