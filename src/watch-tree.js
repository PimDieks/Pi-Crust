// Recursive folder watching that stays cheap on Linux.
// macOS (FSEvents) and Windows watch a whole tree natively with fs.watch({ recursive: true }). On Linux Node emulates
// that by walking every folder synchronously on the main thread and putting an inotify watch on each, node_modules
// included; a big pnpm repo (or one on a slow mount, e.g. Docker on macOS) then blocks the app for minutes.
// Here, on Linux, the tree is walked asynchronously, ignored folders (node_modules, dist, ...) are skipped, symlinks
// are never followed, and inside .git only the folders holding git state (index, HEAD, refs/heads, worktrees) are
// watched. New folders get watched as they appear.
//   watchTree(root, { ignored: Set<name>, skip(relDir) -> bool, onChange(relPath), native? })
// `skip` ignores more folders by path (e.g. gitignored build output); tracked folders stay watched.
//   -> { close(), ready: Promise<number> }
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const MAX_WATCHES = 20000; // across all trees (repo + worktrees); inotify's limit is per user
let totalWatches = 0;
let warned = false;
function warnOnce(msg) {
	if (warned) return;
	warned = true;
	console.warn(`watch-tree: ${msg}; changes in the rest of the tree won't refresh the file list by themselves`);
}

function watchTree(root, { ignored = new Set(), skip = () => false, onChange, native = process.platform !== "linux" } = {}) {
	if (native) {
		const w = fs.watch(root, { recursive: true }, (_ev, file) => file && onChange(String(file)));
		w.on("error", () => {});
		return { close: () => w.close(), ready: Promise.resolve(1) };
	}

	const watchers = new Map(); // absolute dir -> FSWatcher
	let closed = false;

	// Inside .git: the folder itself (index, HEAD, packed-refs), refs/heads/** and worktrees/<name>.
	function gitDirWanted(rel) {
		const parts = rel.split(path.sep);
		if (parts.length === 1) return true; // .git
		if (parts[1] === "refs") return parts.length === 2 || parts[2] === "heads";
		if (parts[1] === "worktrees") return parts.length <= 3;
		return false;
	}
	function wanted(rel) {
		const parts = rel.split(path.sep);
		if (parts[0] === ".git") return gitDirWanted(rel);
		return !parts.some((p) => ignored.has(p)) && !skip(rel);
	}

	function watchDir(abs) {
		if (closed || watchers.has(abs)) return;
		if (totalWatches >= MAX_WATCHES) return warnOnce(`more than ${MAX_WATCHES} folders`);
		let w;
		try {
			w = fs.watch(abs, (ev, name) => {
				if (!name || closed) return;
				const childAbs = path.join(abs, String(name));
				if (ev !== "rename") return onChange(path.relative(root, childAbs));
				// The watched folder itself was deleted or moved away (inotify names it after itself).
				if (!fs.existsSync(abs)) {
					onChange(path.relative(root, abs));
					return abs === root ? retryRoot() : unwatch(abs);
				}
				onChange(path.relative(root, childAbs));
				// Something appeared, disappeared or was replaced: drop old watches there and watch what's there now.
				if (wanted(path.relative(root, childAbs))) {
					unwatch(childAbs);
					fs.promises.lstat(childAbs).then((st) => st.isDirectory() && walk(childAbs), () => {});
				}
			});
		} catch (e) {
			if (e.code === "ENOSPC" || e.code === "EMFILE") warnOnce(`can't add more watches (${e.code})`);
			return; // gone already, or no permission
		}
		w.on("error", () => (abs === root ? retryRoot() : unwatch(abs)));
		watchers.set(abs, w);
		totalWatches++;
	}
	function unwatch(abs) {
		for (const [dir, w] of watchers) {
			if (dir === abs || dir.startsWith(abs + path.sep)) {
				w.close();
				watchers.delete(dir);
				totalWatches--;
			}
		}
	}
	// The root's watch broke (e.g. the folder was replaced): start over once it's back.
	let retryTimer = null;
	function retryRoot() {
		unwatch(root);
		if (closed || retryTimer) return;
		retryTimer = setTimeout(() => {
			retryTimer = null;
			if (!closed && fs.existsSync(root)) walk(root);
			else retryRoot();
		}, 2000);
	}

	// Breadth-first and asynchronous, so the event loop keeps running while a big tree is read.
	async function walk(start) {
		const queue = [start];
		while (queue.length && !closed) {
			const dir = queue.shift();
			watchDir(dir);
			let entries;
			try {
				entries = await fs.promises.readdir(dir, { withFileTypes: true });
			} catch {
				continue;
			}
			for (const e of entries) {
				if (!e.isDirectory()) continue; // symlinks are not followed
				const abs = path.join(dir, e.name);
				if (wanted(path.relative(root, abs))) queue.push(abs);
			}
		}
	}

	const ready = walk(root).then(() => watchers.size);
	return {
		ready,
		close() {
			closed = true;
			clearTimeout(retryTimer);
			unwatch(root);
		},
		_watched: () => [...watchers.keys()].map((d) => path.relative(root, d)).sort(),
	};
}

module.exports = { watchTree };
