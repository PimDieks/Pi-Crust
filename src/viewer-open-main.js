"use strict";
// Main side of "open a project file in the Viewer" (spec: Viewer tabs and project files, tasks 9 to 11): the address-bar suggestions and the one
// door every other way comes through: the tree menu, the Editor button and a dropped file. The decisions are in viewer-open-logic.js; this file
// lists the files, answers the IPC and opens the tab. Nothing a renderer sends is trusted: a path is re-checked here against the OPEN project.
//   browser:suggest(text)        -> { items: [{ path, kind }] }  at most 8 project files that match, kinds the Viewer shows, no dot folder,
//                                    no node_modules, nothing git ignores (when the project is a git project)
//   browser:openFile({ rel })    a project path (tree, Editor)           -> { ok, tabId, path, kind, reused } | { ok: false, message }
//   browser:openFile({ abs })    a real path (a dropped file)            same answer
const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const VO = require("./viewer-open-logic");
const pf = require("./project-files");
const pp = require("./project-protocol");

const WALK_MAX_ENTRIES = 20000;
const WALK_MAX_DEPTH = 12;
const LIST_TTL_MS = 3000;

// deps: { ipcMain, viewerTabs, getRoot, hardenGitArgs, env, selftest, files, protocol }
function register(deps) {
	const files = deps.files || pf;
	const protocol = deps.protocol || pp;
	const logic = VO.create({ files, protocol, breakMode: deps.selftest ? deps.breakMode : "" });
	const cache = new Map(); // root -> { at, paths }
	let gitMissing = false;

	// All files of the project that git would list (tracked, and untracked that are not ignored): the project's own idea of what is in it.
	function gitList(root) {
		return new Promise((resolve) => {
			if (gitMissing || !deps.hardenGitArgs) return resolve(null);
			const args = deps.hardenGitArgs(["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root });
			execFile("git", args, { cwd: root, env: { ...(deps.env || process.env), GIT_OPTIONAL_LOCKS: "0" }, maxBuffer: 50e6, windowsHide: true, timeout: 8000 }, (err, out) => {
				if (err) {
					if (err.code === "ENOENT") gitMissing = true;
					return resolve(null); // not a git project (or git is not there): walk the folder instead
				}
				resolve(String(out).split("\0").filter(Boolean));
			});
		});
	}
	// No git: walk the folder. Dot folders and node_modules are never entered; a link to a folder is not followed (a link to a file is only
	// offered if the final real-path check passes).
	async function walk(root) {
		const out = [];
		let seen = 0;
		const queue = [[root, "", 0]];
		while (queue.length && seen < WALK_MAX_ENTRIES) {
			const [dir, rel, depth] = queue.shift();
			let ents;
			try { ents = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { continue; }
			for (const d of ents) {
				if (++seen > WALK_MAX_ENTRIES) break;
				if (d.name.startsWith(".") || d.name.toLowerCase() === "node_modules") continue;
				const r = rel ? `${rel}/${d.name}` : d.name;
				if (d.isDirectory()) { if (depth < WALK_MAX_DEPTH) queue.push([path.join(dir, d.name), r, depth + 1]); } else out.push(r);
			}
		}
		return out;
	}
	async function listFiles(root) {
		const hit = cache.get(root);
		const ttl = deps.selftest ? 0 : LIST_TTL_MS;
		if (hit && Date.now() - hit.at < ttl) return hit.paths;
		const paths = (await gitList(root)) || (await walk(root));
		cache.set(root, { at: Date.now(), paths });
		return paths;
	}

	const urlOf = (p) => "/" + p.split("/").map(encodeURIComponent).join("/");
	async function suggest(text) {
		const root = deps.getRoot();
		if (!root || typeof text !== "string" || text.length > 300) return { items: [] };
		if (!text.trim()) return { items: [] };
		const paths = await listFiles(root);
		// Every candidate is checked with the same rules as a request (a link that leads outside the project is not offered).
		return { items: VO.suggest(paths, text, { files, accept: (p) => files.resolve(root, urlOf(p), "GET").ok }) };
	}

	// A real path or a project path -> the tab. The check is `checkDropped`: the real path must be inside the open project, not a dot path,
	// of a kind the Viewer shows; `files.isProjectPath` has the last word.
	async function openFile(arg) {
		const root = deps.getRoot();
		if (!arg || typeof arg !== "object") return { ok: false, message: VO.R.invalid };
		let abs = null;
		if (typeof arg.rel === "string" && root) {
			if (arg.rel.includes("\0") || arg.rel.length > files.MAX_PATH) return { ok: false, message: VO.R.invalid };
			abs = path.resolve(root, ...arg.rel.replace(/\\/g, "/").split("/").filter(Boolean));
		} else if (typeof arg.abs === "string") abs = arg.abs;
		const r = logic.checkDropped(root, abs);
		if (r.refuse) return { ok: false, message: r.refuse };
		const res = await deps.viewerTabs.openFile(protocol.toAddress(root, r.file.path));
		if (!res.ok) return { ok: false, message: res.message || VO.R.invalid };
		return { ok: true, tabId: res.tabId, reused: !!res.reused, path: r.file.path, kind: r.file.kind };
	}

	deps.ipcMain.handle("browser:suggest", (_e, text) => suggest(text).catch(() => ({ items: [] })));
	deps.ipcMain.handle("browser:openFile", (_e, arg) => openFile(arg).catch((e) => ({ ok: false, message: String((e && e.message) || e).slice(0, 200) })));
	return { suggest, openFile, listFiles };
}

module.exports = { register };
