"use strict";
// What the agent's tool `show_in_viewer` may show (spec: Viewer tabs and project files, section D and task 13). Pure apart from the file
// system (injectable): no Electron import. Used by viewer-agent-main.js and tested in scripts/viewer-agent.test.js.
//   check(root, text, { worktree })  -> { address } | { file: { path, kind } } | { refuse }
//   newTabAllowed(counter)           the rate rule: at most MAX_NEW_PER_TURN new tabs per turn and chat
// The model's text is data. The path goes through the same checks as the address bar and the drop (viewer-open-logic.js, which ends in
// project-files.js `resolve` and `isProjectPath`); an address must be local, by the same host list the app's `isLocal` uses. The refusal
// texts are the address bar's own where it has one (viewer-open-logic.js R); the few that only this tool needs are below.
const nodePath = require("node:path");
const VO = require("./viewer-open-logic");
const pf = require("./project-files");
const T = require("./viewer-agent-target");

const MAX_NEW_PER_TURN = 3;
const R = {
	...VO.R,
	arg: "Give one file path of this project or one localhost address.",
	host: "Only localhost addresses (localhost, 127.0.0.1 or [::1]) can be shown here.",
	worktree: "This chat works in a worktree. Only files of the open project can be shown here.",
	rate: "Several new pages were already opened in this turn. Ask the person which one to look at.",
	notrunning: "This chat is not running, so nothing was shown.",
	remote: "That is this app's own Remote port, not a page of yours. It can't be shown here.",
};

function create(opts = {}) {
	const files = opts.files || pf;
	const platform = opts.platform || process.platform;
	const path = opts.path || (platform === "win32" ? nodePath.win32 : nodePath.posix);
	const vo = VO.create({ ...opts, files, breakMode: "" }); // the bar's own rules; the deliberate breaks of this tool are below
	// Selftest and tests only (the caller passes it only then): the deliberate breaks, each of which must make its group fail.
	//   agent-host   a web address on any host is accepted
	//   agent-path   the path is not checked against the project (any real file path passes)
	const brk = opts.breakMode || "";
	// The ports of the app's own Remote server (a function: it can change while the app runs). A localhost address on one of them is not a page
	// the person's project serves; showing it would put the app's own pairing and chat pages in the Viewer.
	const remotePorts = typeof opts.remotePorts === "function" ? opts.remotePorts : () => [];
	const portOf = (url) => {
		const u = new URL(url);
		return Number(u.port) || (u.protocol === "https:" ? 443 : 80);
	};

	function check(root, raw, ctx = {}) {
		const t = T.parse(raw);
		if (t.kind === "invalid") return { refuse: typeof raw === "string" && raw.trim() ? R.invalid : R.arg };
		if (t.kind === "scheme") return { refuse: R.scheme }; // file:, pi-project:, javascript:, data:, ftp: ... a model never types an internal address
		if (t.kind === "address") {
			if (!(t.local || brk === "agent-host")) return { refuse: R.host };
			let blocked = [];
			try { blocked = remotePorts() || []; } catch { /* no list: nothing is known to refuse */ }
			return blocked.includes(portOf(t.url)) ? { refuse: R.remote } : { address: t.url };
		}
		// A path.
		if (!root) return { refuse: R.noproject };
		if (ctx.worktree) return { refuse: R.worktree };
		if (brk === "agent-path") {
			const abs = path.isAbsolute(t.text) ? t.text : path.join(root, t.text);
			const k = files.kindOf(path.basename(abs));
			return k === "other" ? { refuse: R.kind } : { file: { path: abs, kind: k } };
		}
		const r = vo.checkTyped(root, t.text);
		if (r.refuse) return { refuse: r.refuse };
		if (r.web) {
			// No such file, and the bar would have tried the web: a name with a known file kind is a missing file, anything else is not local.
			const last = t.text.replace(/\\/g, "/").split("/").pop();
			return { refuse: files.kindOf(last) !== "other" ? R.missing : R.host };
		}
		// The last word is the one gate every request uses (the typed text was judged by its name; this by the real file).
		const abs = path.join(root, ...r.file.path.split("/"));
		if (!files.isProjectPath(root, abs)) return { refuse: R.outside };
		return { file: r.file };
	}

	return { check };
}

// counter: { opened: <new tabs opened so far in this turn> }
const newTabAllowed = (counter, brkMode = "") => brkMode === "agent-rate" || !counter || counter.opened < MAX_NEW_PER_TURN;

module.exports = { create, newTabAllowed, R, MAX_NEW_PER_TURN };
