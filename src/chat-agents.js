// Which agent a chat belongs to, and what that means for the saved tab list and the history list (phase 7, T8). Pure: no Electron.
// A chat's agent is set when it is created and never changes. A missing agent always reads as the default (Pi), which is what keeps
// open-chats.json from older versions, and Pi chats today, exactly as they were.
"use strict";

const { DEFAULT_ID } = require("./agents/registry");

const HISTORY_CAP = 60; // the cap of Pi's own reader (agents/pi/sessions.js)

// A chat's agent id from a stored or requested value: undefined/null/"" -> the default; a string stays as it is (the caller checks it
// against the registry); anything else is not an id.
function agentIdOf(v) {
	if (v === undefined || v === null || v === "") return DEFAULT_ID;
	return typeof v === "string" ? v : null;
}

// The agent for a new chat: the requested id (none = Pi) when the registry has it, else null (refused).
function resolveNewChatAgent(requested, registry) {
	const id = agentIdOf(requested);
	return id !== null && registry.has(id) ? id : null;
}

// Open chats of one repo -> the record written under that repo in open-chats.json. The old fields (files, active, cwds) are written
// exactly as before; `agents` maps a session reference to its agent and lists only the chats that are not Pi, so a file with Pi chats
// only is byte-identical to what older versions wrote. A reader that does not know `agents` ignores it.
function serializeOpenChats(openList, activeChatId) {
	const files = [...new Set(openList.map((e) => e.file).filter(Boolean))];
	const cwds = {};
	const agents = {};
	for (const e of openList) {
		if (e.file && e.cwd) cwds[e.file] = e.cwd; // chats in a worktree reopen there
		if (e.file && e.agent && e.agent !== DEFAULT_ID) agents[e.file] = e.agent;
	}
	const rec = { files, active: openList.find((e) => e.id === activeChatId)?.file || null, cwds };
	if (Object.keys(agents).length) rec.agents = agents;
	return rec;
}

// The record of one repo -> entries to restore [{ file, cwd, agent }]. `exists(file)` is asked for Pi chats only: a Claude session
// reference is an id, not a path. An entry whose agent id is not a string is read as Pi's default, never dropped.
function restoreEntries(saved, exists) {
	const s = saved && typeof saved === "object" ? saved : {};
	const agents = s.agents && typeof s.agents === "object" ? s.agents : {};
	const out = [];
	for (const file of new Set(Array.isArray(s.files) ? s.files : [])) {
		if (typeof file !== "string" || !file) continue;
		const agent = typeof agents[file] === "string" && agents[file] ? agents[file] : DEFAULT_ID;
		if (agent === DEFAULT_ID && !exists(file)) continue;
		out.push({ file, cwd: typeof s.cwds?.[file] === "string" ? s.cwds[file] : null, agent });
	}
	return out;
}

// The reader of the last released app (main, before this change), for the compatibility test: it knows files, active and cwds only.
function legacyRestoreEntries(saved, exists) {
	const files = [...new Set((saved || {}).files || [])].filter((f) => typeof f === "string" && exists(f));
	return files.map((file) => ({ file, cwd: typeof saved.cwds?.[file] === "string" ? saved.cwds[file] : null }));
}

// History: every registered adapter is asked; one that fails gives an empty list with its reason and does not touch the others.
// The Pi-style adapter (the default) is asked once with { repo, worktrees } as before; any other gets one call per folder.
// Entries are tagged with `agent`, merged newest first, at most HISTORY_CAP.
// Returns { sessions, status: { [agentId]: { ok, count, reason? } } }.
async function listAllSessions({ adapters, repo, worktrees = [] }) {
	const status = {};
	const parts = await Promise.all(
		adapters.map(async (a) => {
			try {
				let list;
				if (a.id === DEFAULT_ID) list = await a.listSessions({ cwd: repo, repo, worktrees });
				else {
					list = [];
					for (const src of [{ cwd: repo, branch: null, wt: false }, ...worktrees.map((w) => ({ cwd: w.cwd, branch: w.branch, wt: true }))]) {
						const got = await a.listSessions({ cwd: src.cwd });
						for (const s of Array.isArray(got) ? got : []) list.push(src.wt ? { ...s, cwd: src.cwd, branch: src.branch || null } : s);
					}
				}
				if (!Array.isArray(list)) throw new Error("the list is not an array");
				status[a.id] = { ok: true, count: list.length };
				return list.map((s) => ({ ...s, agent: a.id }));
			} catch (e) {
				status[a.id] = { ok: false, count: 0, reason: (e && e.message) || String(e) };
				return [];
			}
		}),
	);
	const sessions = parts.flat().sort((x, y) => (y.mtime || 0) - (x.mtime || 0)).slice(0, HISTORY_CAP);
	return { sessions, status };
}

module.exports = { agentIdOf, resolveNewChatAgent, serializeOpenChats, restoreEntries, legacyRestoreEntries, listAllSessions, HISTORY_CAP };
