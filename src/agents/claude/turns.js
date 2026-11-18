// Turns of a Claude Agent chat, and the links of its forks (phase 7, rewind and fork). Pure logic plus two small stores in the app's own
// Claude config folder. No SDK import, no Electron.
//
// Why this exists: the SDK numbers nothing for us. A rewind or a fork needs "the message to cut before" and "the assistant message that
// ends the turn to keep" (resumeSessionAt takes that uuid: capture-rewind and capture-fork, section 10 of claude-sdk-capture-findings).
// So the adapter supplies a uuid on every user message it sends and remembers, per turn, the uuid of the last assistant message. A turn is
//   { uuid, text, at, assistantUuid }   assistantUuid is null until an answer arrived.
// The list is kept per session in <config>/crust-turns/<sessionId>.json and survives a restart. The SDK keeps these uuids in its own
// transcript too, so turnsFromRows() can rebuild the list when the file is missing (older chats, a deleted file).
// Forks: the SDK links nothing and gives every fork the same title, so the app keeps { parent, at, title } per child session in
// <config>/crust-forks.json.
"use strict";

const path = require("node:path");

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;
const TEXT_MAX = 4000;
const TITLE_MAX = 80;

const normText = (t) => String(t == null ? "" : t).replace(/\s+/g, " ").trim();

function cleanTurn(t) {
	if (!isObj(t) || typeof t.uuid !== "string" || !t.uuid) return null;
	return { uuid: t.uuid, text: String(t.text == null ? "" : t.text).slice(0, TEXT_MAX), at: Number.isFinite(t.at) ? t.at : 0, assistantUuid: typeof t.assistantUuid === "string" && t.assistantUuid ? t.assistantUuid : null };
}

// The turns of a session from the SDK's history rows (getSessionMessages): a turn starts at a user row with text (not a tool result, not
// from a subagent) and its assistantUuid is the last main-thread assistant row before the next such user row.
function turnsFromRows(rows) {
	const out = [];
	for (const row of Array.isArray(rows) ? rows : []) {
		if (!isObj(row) || !isObj(row.message) || row.parent_tool_use_id) continue;
		if (row.type === "user") {
			const c = row.message.content;
			const blocks = typeof c === "string" ? [{ type: "text", text: c }] : Array.isArray(c) ? c : [];
			if (blocks.some((b) => isObj(b) && b.type === "tool_result")) continue;
			const text = blocks.filter((b) => isObj(b) && b.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n");
			if (!text.trim() || /^\[Request interrupted by user[^\]]*\]$/.test(text.trim())) continue;
			if (typeof row.uuid !== "string" || !row.uuid) continue;
			out.push({ uuid: row.uuid, text: text.slice(0, TEXT_MAX), at: Date.parse(row.timestamp) || 0, assistantUuid: null });
		} else if (row.type === "assistant" && out.length && typeof row.uuid === "string" && row.uuid) out[out.length - 1].assistantUuid = row.uuid;
	}
	return out;
}

// What the app lists as "messages to go back to": the user messages, newest last. entryId is the message's uuid.
function forkMessages(turns) {
	return turns.map((t) => ({ entryId: t.uuid, text: t.text }));
}

// What a rewind or fork "before message X" (or from the end, entryId null) needs.
//   { ok:true, keep:[turns kept], text, resume:{ at } }   at: the assistant uuid to pass as resumeSessionAt; null = nothing is kept
//   { ok:true, keep:[all], text:null, end:true }          from the end: resume + forkSession only (capture-fork query 2)
//   { ok:false, error }
function plan(turns, entryId) {
	if (entryId === null || entryId === undefined) {
		if (!turns.length) return { ok: false, error: "Nothing to fork from yet" };
		return { ok: true, keep: turns.slice(), text: null, end: true, at: null };
	}
	const i = turns.findIndex((t) => t.uuid === entryId);
	if (i < 0) return { ok: false, error: "That message is not in this chat's history any more." };
	const keep = turns.slice(0, i);
	if (!keep.length) return { ok: true, keep, text: turns[i].text, at: null };
	const at = keep[keep.length - 1].assistantUuid;
	if (!at) return { ok: false, error: "The message before it has no finished answer, so there is nothing to go back to there." };
	return { ok: true, keep, text: turns[i].text, at };
}

// The stores. fs and dir are injected; every method fails soft (a store that cannot be read is empty, one that cannot be written is skipped).
function createStores({ fs, dir }) {
	const file = (...p) => path.join(dir(), ...p);
	const readJson = (f) => {
		try {
			return JSON.parse(fs.readFileSync(f, "utf8"));
		} catch {
			return null;
		}
	};
	const writeJson = (f, v) => {
		try {
			fs.mkdirSync(path.dirname(f), { recursive: true });
			fs.writeFileSync(`${f}.tmp`, JSON.stringify(v), { mode: 0o600 });
			fs.renameSync(`${f}.tmp`, f);
		} catch {}
	};
	const have = () => !!dir();
	return {
		loadTurns(sessionId) {
			if (!have() || !SAFE_ID.test(String(sessionId))) return null;
			const d = readJson(file("crust-turns", `${sessionId}.json`));
			return d && Array.isArray(d.turns) ? d.turns.map(cleanTurn).filter(Boolean) : null;
		},
		saveTurns(sessionId, turns) {
			if (!have() || !SAFE_ID.test(String(sessionId))) return;
			writeJson(file("crust-turns", `${sessionId}.json`), { turns: turns.map(cleanTurn).filter(Boolean) });
		},
		forkOf(sessionId) {
			if (!have()) return null;
			const all = readJson(file("crust-forks.json"));
			const f = all && isObj(all.forks) ? all.forks[sessionId] : null;
			return isObj(f) && typeof f.parent === "string" ? { parent: f.parent, at: typeof f.at === "string" ? f.at : null, title: typeof f.title === "string" ? f.title : null } : null;
		},
		linkFork(childId, { parent, at = null, title = null }) {
			if (!have() || !SAFE_ID.test(String(childId)) || typeof parent !== "string") return;
			const all = readJson(file("crust-forks.json"));
			const forks = all && isObj(all.forks) ? all.forks : {};
			forks[childId] = { parent, at, title: title ? String(title).slice(0, TITLE_MAX) : null, created: Date.now() };
			writeJson(file("crust-forks.json"), { forks });
		},
	};
}

const forkTitle = (parentTitle) => `Fork of ${normText(parentTitle) || "chat"}`.slice(0, TITLE_MAX);

module.exports = { turnsFromRows, forkMessages, plan, createStores, forkTitle, cleanTurn, normText, SAFE_ID };
