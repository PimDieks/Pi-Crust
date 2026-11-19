"use strict";
// Opening a project file in the Viewer, the decisions (spec: Viewer tabs and project files, section C "Address" and tasks 9 to 11).
// Pure apart from the file system (injectable): no Electron import. Used by viewer-open-main.js and tested in scripts/viewer-open.test.js.
//   checkTyped(root, text)    what the address bar does with typed text: { web } | { file } | { refuse }
//   checkDropped(root, abs)   a real path (dropped file, tree, Editor): { file } | { refuse }
//   suggest(paths, query)     the project files to offer while typing (max 8)
// A "file" answer carries `path` (the project path, forward slashes) and `kind` (page, image, pdf). The refusal texts are the ones the
// person reads; they are the single source for the bar, the tree, the Editor and the drop.
const nodeFs = require("node:fs");
const nodePath = require("node:path");
const pf = require("./project-files");
const pp = require("./project-protocol");

const R = {
	outside: "Only files inside this project can be shown here.",
	folder: "Folders can't be shown here. Choose a file.",
	dot: "Files and folders that start with a dot are never shown here.",
	kind: "Only web pages (HTML), images and PDFs can be shown here.",
	missing: "No such file in this project.",
	scheme: "Only web addresses (http, https) and files in this project can be shown here.",
	unknown: "That is not a web address or a file in this project.",
	noproject: "Open a project first.",
	invalid: "That path can't be shown here.",
	limit: "8 pages is the most. Close one first.",
};
const MAX_SUGGESTIONS = 8;

const refuse = (reason) => ({ refuse: reason });
const SHOWN = new Set(["page", "image", "pdf"]);
// A project path's segments start with a dot (a dot file or a dot folder).
const hasDotSegment = (segs) => segs.some((s) => s.startsWith("."));
const urlOf = (segs) => "/" + segs.map(encodeURIComponent).join("/");

// scheme: "http", "file", "pi-project", a single letter for a drive ("C:\x"); "" when the text has none. "localhost:3000" and
// "example.com:8080/x" are host:port, not a scheme.
function schemeOf(text) {
	const m = /^([a-z][a-z0-9+.-]*):(?!\d+(?:[/?#]|$))/i.exec(text);
	return m ? m[1].toLowerCase() : "";
}
// What the bar has always turned into https:// (localhost, a name with a dot, an IPv4 address, an IPv6 literal; an optional port and path).
const HOSTLIKE = /^(?:localhost|[a-z0-9_-]+(?:\.[a-z0-9_-]+)+|\[[0-9a-f:.]+\])(?::\d+)?(?:[/?#]|$)|^[a-z0-9_-]+:\d+(?:[/?#]|$)/i;
const isHostLike = (text) => HOSTLIKE.test(text);

function create(opts = {}) {
	const fs = opts.fs || nodeFs;
	const platform = opts.platform || process.platform;
	const path = opts.path || (platform === "win32" ? nodePath.win32 : nodePath.posix);
	const files = opts.files || pf;
	const protocol = opts.protocol || pp;
	const real = (p) => (fs.realpathSync.native || fs.realpathSync)(p);
	// Selftest only (the caller passes it only then): the deliberate breaks of the step viewer-open, each of which must make it fail.
	//   open-bar   a typed path with a dot segment is not refused
	//   open-drop  a dropped path is judged by its name, not by where it really leads (a link pointing outside gets through)
	const brk = opts.breakMode || "";

	// The path of `abs` under `base` as segments, or null when it is not below it (the comparison is the platform's, like path.relative's).
	function under(base, abs) {
		const rel = path.relative(base, abs);
		if (!rel || rel === "." || path.isAbsolute(rel) || rel.split(/[\\/]/)[0] === "..") return null;
		return rel.split(/[\\/]/).filter(Boolean);
	}

	// resolve() for a project path (segments), mapped to our reasons.
	function checkSegs(root, segs) {
		if (hasDotSegment(segs) && brk === "open-bar") return { file: { path: segs.join("/"), kind: files.kindOf(segs[segs.length - 1]) } };
		if (hasDotSegment(segs)) return refuse(R.dot);
		const r = files.resolve(root, urlOf(segs), "GET");
		if (!r.ok) {
			if (r.status === 404) return refuse(/folder/i.test(r.reason || "") ? R.folder : R.missing);
			if (r.status === 403) return refuse(/outside/i.test(r.reason || "") ? R.outside : /dot/i.test(r.reason || "") ? R.dot : R.invalid);
			return refuse(R.invalid);
		}
		const kind = files.kindOf(segs[segs.length - 1]);
		if (!SHOWN.has(kind)) return refuse(R.kind);
		return { file: { path: segs.join("/"), kind } };
	}

	const isAbs = (t) => path.isAbsolute(t) || /^[a-z]:[\\/]/i.test(t) || /^[\\/]{2}/.test(t);

	// A real path from the OS or the app (a dropped file, the tree, the Editor). Always re-checked here, never trusted.
	function checkDropped(root, abs) {
		if (typeof root !== "string" || !root) return refuse(R.noproject);
		if (typeof abs !== "string" || !abs || abs.includes("\0") || !path.isAbsolute(abs)) return refuse(R.invalid);
		let st;
		try { st = fs.statSync(abs); } catch { return refuse(R.missing); }
		if (st.isDirectory()) return refuse(R.folder);
		if (!st.isFile()) return refuse(R.invalid);
		let realRoot, realAbs;
		try { realRoot = real(root); realAbs = brk === "open-drop" ? abs : real(abs); } catch { return refuse(R.missing); }
		// A link (a symlink, a junction) is judged by where it leads: the real path must be inside the project.
		const segs = under(realRoot, realAbs);
		if (!segs) return refuse(R.outside);
		if (hasDotSegment(segs)) return refuse(R.dot);
		const kind = files.kindOf(segs[segs.length - 1]);
		if (!SHOWN.has(kind)) return refuse(R.kind);
		if (brk !== "open-drop" && !files.isProjectPath(root, realAbs)) return refuse(R.outside); // the single gate every request uses has the last word
		return { file: { path: segs.join("/"), kind } };
	}

	// Typed text in the address bar.
	function checkTyped(root, raw) {
		const text = String(raw == null ? "" : raw).trim();
		if (!text) return refuse(R.unknown);
		const scheme = schemeOf(text);
		if (scheme === "http" || scheme === "https") return { web: text };
		if (scheme === "pi-project") {
			// The internal address, typed by hand: only this project's, of a kind the Viewer shows.
			const p = root ? protocol.fromAddress(root, text) : null;
			if (p == null) return refuse(root ? R.outside : R.noproject);
			const segs = p.split("/").filter(Boolean);
			return segs.length ? checkSegs(root, segs) : refuse(R.missing);
		}
		if (scheme.length > 1) return refuse(R.scheme); // file:, javascript:, data:, ftp:, about: ...
		if (!root) return isHostLike(text) ? { web: `https://${text}` } : refuse(R.noproject);
		if (isAbs(text)) {
			// A real path typed in: fine when it is a project file, else outside the project.
			if (/^[\\/]{2}/.test(text) && platform === "win32") return refuse(R.outside);
			const r = checkDropped(root, path.normalize(text));
			return r.refuse === R.missing ? refuse(R.outside) : r;
		}
		const parts = text.replace(/\\/g, "/").split("/");
		const segs = [];
		for (const s of parts) {
			if (s === "" || s === ".") continue;
			if (s === "..") {
				if (!segs.length) return refuse(R.outside);
				segs.pop();
				continue;
			}
			segs.push(s);
		}
		if (!segs.length) return refuse(R.unknown);
		const r = checkSegs(root, segs);
		if (r.file) return r;
		// No such project file: host-like text goes to the web as before; otherwise say why the path was not opened.
		if (isHostLike(text) && (r.refuse === R.missing || r.refuse === R.invalid)) return { web: `https://${text}` }; // "localhost:3000" has a colon: never a file name
		if (r.refuse === R.missing) return refuse(parts.length > 1 || /\.[a-z0-9]{1,5}$/i.test(text) ? R.missing : R.unknown);
		return r;
	}

	return { checkTyped, checkDropped, checkSegs };
}

// --- suggestions --------------------------------------------------------------------------------------------------------------
// Which project paths may ever be offered: a kind the Viewer shows, no dot segment, no node_modules.
function offerable(p, files = pf) {
	const segs = String(p).split("/");
	if (segs.some((s) => s === "" || s.startsWith(".") || s.toLowerCase() === "node_modules")) return false;
	return SHOWN.has(files.kindOf(segs[segs.length - 1]));
}
// Rank `paths` for `query` (case-insensitive; every word must appear in the path; a file name that starts with the first word comes
// first, then one that contains it, then a path that starts with it, then the rest; shorter paths first) and return at most `limit`.
// `accept(path)` may veto a candidate (the real-path check); candidates are taken in rank order until `limit` are accepted.
function suggest(paths, query, { limit = MAX_SUGGESTIONS, accept = () => true, files = pf } = {}) {
	const q = String(query == null ? "" : query).trim().toLowerCase().replace(/\\/g, "/").replace(/^\.?\//, "");
	if (!q || schemeOf(q) || /^[a-z0-9-]+(?:\.[a-z0-9-]+)*:\d+/.test(q)) return [];
	const words = q.split(/\s+/).filter(Boolean);
	const scored = [];
	for (const p of paths) {
		if (!offerable(p, files)) continue;
		const low = p.toLowerCase();
		if (!words.every((w) => low.includes(w))) continue;
		const base = low.slice(low.lastIndexOf("/") + 1);
		const rank = base.startsWith(words[0]) ? 0 : base.includes(words[0]) ? 1 : low.startsWith(words[0]) ? 2 : 3;
		scored.push({ p, rank });
	}
	scored.sort((a, b) => a.rank - b.rank || a.p.length - b.p.length || (a.p < b.p ? -1 : a.p > b.p ? 1 : 0));
	const out = [];
	for (const s of scored) {
		if (out.length >= limit) break;
		if (accept(s.p)) out.push({ path: s.p, kind: files.kindOf(s.p) });
	}
	return out;
}

module.exports = { create, suggest, offerable, schemeOf, isHostLike, R, MAX_SUGGESTIONS };
