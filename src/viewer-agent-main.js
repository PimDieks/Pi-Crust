"use strict";
// Main side of the agent's tool `show_in_viewer` (spec: Viewer tabs and project files, sections D and E, task 13), the same for both agents:
// Pi reaches it through its extension (src/pi-viewer-tool.js asks the app, main.js hands the question to `show`), the Claude
// Agent through its host-defined tool (src/agents/claude/viewer-tool.js). The model's text is data: everything is decided here.
//   show(chatId, target) -> Promise<{ ok, text, ... }>   `text` is what the agent reads as the tool's result, success or refusal
//   turnStarted(chatId)  a new turn of a chat: its count of new tabs starts again
//   chatClosed(chatId)
// The permission rule is NOT here: it is the shared logic's (permission-logic.js decideShow: what reading the file needs in the chat's current
// mode, never a question of its own), applied by each agent's own gate before the tool runs. What this file adds is what only the app knows:
// the open project, the chat's working folder, the 8-page limit, the rate and the tabs.
const nodePath = require("node:path");
const AL = require("./viewer-agent-logic");
const pp = require("./project-protocol");

const R = AL.R;

// deps: { getRoot, viewerTabs, chatInfo(chatId) -> { cwd: string | null } | null, send, files, protocol, breakMode (selftest only), selftest, platform }
function create(deps) {
	const brk = deps.selftest ? deps.breakMode || "" : "";
	const protocol = deps.protocol || pp;
	const logic = AL.create({ files: deps.files, protocol, platform: deps.platform, breakMode: brk });
	const turns = new Map(); // chatId -> { opened } (new tabs opened in the current turn)
	const platform = deps.platform || process.platform;
	const sameDir = (a, b) => {
		const n = (p) => nodePath.resolve(String(p)).replace(/[\\/]+$/, "");
		return platform === "win32" || platform === "darwin" ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b);
	};
	const counter = (chatId) => {
		let c = turns.get(chatId);
		if (!c) turns.set(chatId, (c = { opened: 0 }));
		return c;
	};
	const no = (text) => ({ ok: false, text });

	async function show(chatId, target) {
		const chat = deps.chatInfo(chatId);
		if (!chat) return no(R.notrunning);
		const root = deps.getRoot();
		// A chat that works in a worktree has its own working folder: its files are not the open project's. Only when that folder IS the open
		// project do files count; a localhost address does not depend on the folder.
		const worktree = !!(chat.cwd && root && !sameDir(chat.cwd, root));
		const r = logic.check(root, target, { worktree });
		if (r.refuse) return no(r.refuse);
		const address = r.address || protocol.toAddress(root, r.file.path);
		const label = r.file ? r.file.path : address;
		const c = counter(chatId);
		const res = await deps.viewerTabs.openBackground(address, { allowNew: AL.newTabAllowed(c, brk) });
		if (!res.ok) return no(res.reason === "rate" ? R.rate : res.reason === "limit" ? R.limit : res.message || R.invalid);
		if (!res.reused) c.opened++;
		deps.send("browser:agentShown", { chatId, tabId: res.tabId, label, kind: r.file ? r.file.kind : "address", reused: !!res.reused, active: !!res.active });
		const text = res.reused
			? res.active
				? `Already open in the Viewer, and it is the page the person is looking at: ${label}.`
				: `Already open in the Viewer: ${label}. Its tab is marked as updated; the person's view did not change.`
			: `Shown in a new background tab of the Viewer: ${label}. The person's view did not change; the Viewer tab has a badge until they look.`;
		return { ok: true, text, tabId: res.tabId, label, reused: !!res.reused };
	}

	// The chat's tool card was clicked: the tab that shows this target becomes the active tab. Only an existing tab is used, nothing opens.
	async function focus(target) {
		const root = deps.getRoot();
		const r = logic.check(root, target, {});
		if (r.refuse) return { ok: false, message: r.refuse };
		const res = await deps.viewerTabs.activateShowing(r.address || protocol.toAddress(root, r.file.path));
		return res.ok ? { ok: true, tabId: res.tabId } : { ok: false, message: "That page is not open any more." };
	}

	return {
		show,
		focus,
		turnStarted: (chatId) => void turns.delete(chatId),
		chatClosed: (chatId) => void turns.delete(chatId),
		opened: (chatId) => (turns.get(chatId) || { opened: 0 }).opened,
	};
}

module.exports = { create, R };
