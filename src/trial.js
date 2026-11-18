// Switches for a real trial of the Claude Agent by a person (not a test), and the trial log. Pure: no Electron.
// Both switches work only in an unpackaged app (npm start from a checkout): a stray variable on an installed app does nothing, like the self-test switches.
//   PI_CRUST_USERDATA=<absolute folder>   the app's data folder (settings, recent projects, open chats, the Claude key store, the engine, the
//                                         Claude config) is this folder instead of %APPDATA%\pi-crust, so a trial never touches the real ones.
//   PI_CRUST_TRIAL_LOG=<absolute file>    one JSON line per Claude Agent chat start and one per permission-gate decision are appended to this file.
// The log holds counts and names the engine reported, tool names and outcomes. It never holds the key, file contents, commands or prompt text.
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const absolute = (v) => (typeof v === "string" && v.trim() !== "" && path.isAbsolute(v.trim()) ? path.normalize(v.trim()) : null);

// The folder for app.setPath("userData"), or null (keep the normal one). Never in a packaged app; never a relative path.
function userDataOverride({ isPackaged, env = process.env } = {}) {
	if (isPackaged) return null;
	return absolute(env.PI_CRUST_USERDATA);
}

// The trial log file, or null (no log). Never in a packaged app; never a relative path.
function trialLogFile({ isPackaged, env = process.env } = {}) {
	if (isPackaged) return null;
	return absolute(env.PI_CRUST_TRIAL_LOG);
}

// A name the engine reported (a skill, plugin, MCP server, agent, tool, version, mode ...): short, plain characters only, and never anything that
// looks like a key. Anything else is dropped (null).
function safeName(v, max = 60) {
	if (typeof v !== "string") return null;
	const t = v.trim();
	if (!t || t.length > max || !/^[A-Za-z0-9 _:.@/+-]+$/.test(t) || /sk-ant/i.test(t)) return null;
	return t;
}
function names(list, max = 40) {
	if (!Array.isArray(list)) return { count: 0, names: [] };
	const out = [];
	for (const x of list) {
		const n = safeName(typeof x === "string" ? x : x && typeof x === "object" ? x.name : null);
		if (n) out.push(n);
		if (out.length >= max) break;
	}
	return { count: list.length, names: out };
}

// createTrialLog({ file, fsApi?, now? }) -> { chatStart(chatNo, init, appMode, again), hook(ev), final(ev) } or null without a file.
function createTrialLog({ file, fsApi = fs, now = () => new Date() } = {}) {
	if (typeof file !== "string" || !file) return null;
	let made = false;
	const write = (obj) => {
		try {
			if (!made) {
				fsApi.mkdirSync(path.dirname(file), { recursive: true });
				made = true;
			}
			fsApi.appendFileSync(file, JSON.stringify({ t: now().toISOString(), ...obj }) + "\n");
		} catch {}
	};
	const hooked = new Map(); // tool_use_id -> { tool, by }: the hook said "ask", canUseTool gives the final outcome
	const by = (sub) => (sub ? "subagent" : "main");
	return {
		// What the engine said in its init message: counts and names only.
		chatStart(chatNo, init, appMode, again) {
			const m = init && typeof init === "object" ? init : {};
			write({
				ev: "chat_start",
				chat: typeof chatNo === "string" ? safeName(chatNo, 80) : chatNo,
				again: !!again,
				engineVersion: safeName(m.claude_code_version, 40),
				keySource: safeName(m.apiKeySource, 40),
				enginePermissionMode: safeName(m.permissionMode, 40),
				appMode: safeName(appMode, 40),
				skills: names(m.skills),
				plugins: names(m.plugins),
				mcpServers: { ...names(m.mcp_servers), status: Array.isArray(m.mcp_servers) ? m.mcp_servers.map((s) => safeName(s && s.status, 20)).filter(Boolean).slice(0, 40) : [] },
				agents: names(m.agents),
			});
		},
		// The hook's answer. A deny is final; an ask waits for canUseTool's outcome.
		hook({ id, tool, answer, sub }) {
			const t = safeName(tool, 80) || "?";
			const a = answer === "deny" ? "deny" : "ask";
			if (a === "deny") return write({ ev: "gate", tool: t, hook: "deny", outcome: "deny", prompted: false, by: by(sub) });
			if (typeof id === "string" && id) {
				hooked.set(id, { tool: t, by: by(sub) });
				if (hooked.size > 500) hooked.delete(hooked.keys().next().value);
			}
		},
		final({ id, tool, outcome, prompted, sub }) {
			const h = typeof id === "string" ? hooked.get(id) : null;
			if (h) hooked.delete(id);
			write({ ev: "gate", tool: h ? h.tool : safeName(tool, 80) || "?", hook: h ? "ask" : "none", outcome: outcome === "allow" ? "allow" : "deny", prompted: !!prompted, by: h ? h.by : by(sub) });
		},
	};
}

module.exports = { userDataOverride, trialLogFile, createTrialLog, safeName };
