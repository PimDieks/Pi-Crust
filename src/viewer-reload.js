"use strict";
// Live reload for project files in the Viewer (spec: Viewer tabs and project files, section C "Live reload", task 12). No Electron here:
// the tab model (viewer-tabs-main.js) tells this module which real files a tab uses; this module watches them and says, after a quiet
// pause, which tab's files changed. A node test covers it (scripts/viewer-reload.test.js).
//
// Watching: one fs.watch per DIRECTORY that holds a file some tab uses (never recursive, never outside the project: the files come from
// project-files.js resolve, or from the project root plus the page's own path). A directory watcher is used instead of a file watcher
// because editors save by writing a new file and renaming it over the old one, which a file watcher loses. Events carry a file name;
// only a name a tab uses counts, so a build that writes hundreds of other files in the same folder reaches nobody. Watchers are shared
// between tabs by reference count and closed when the last tab that needs the folder lets go.
//
// Bounded: at most MAX_FILES files per tab (the page, then what it loaded, in request order; the rest are not watched). A tab's list is
// cleared when its page navigates.
//
// Pause: `debounceMs` (250) after the LAST change of a tab, per tab: many quick saves, or a build writing for a while, give one call.
//
// A folder that is gone (deleted, renamed) or a watcher that fails is kept as "pending" and tried again every second, so a file that
// comes back in a folder that came back is noticed (and a tab whose file was deleted can load again). On Windows a watcher of a deleted
// folder does not fail: it stays open on the dead folder, so every second the folder's identity is compared with the one it was opened on.
// A folder that is now reached through a link is never watched again.
const nodeFs = require("node:fs");
const nodePath = require("node:path");

const MAX_FILES = 64;
const DEBOUNCE_MS = 250;
const RETRY_MS = 1000;

function create(opts = {}) {
	const fs = opts.fs || nodeFs;
	const path = opts.path || nodePath;
	const onChange = opts.onChange || (() => {});
	const debounceMs = opts.debounceMs == null ? DEBOUNCE_MS : opts.debounceMs;
	const insensitive = opts.insensitive != null ? !!opts.insensitive : process.platform === "win32" || process.platform === "darwin";
	// Selftest only: "reload-leak" (a tab that goes leaves its watchers open), "reload-any" (any name in a watched folder counts).
	const brk = opts.breakMode || "";
	const keyOf = (p) => (insensitive ? p.toLowerCase() : p);

	const tabs = new Map(); // tab id -> { files: Map(key -> real path), timer }
	const dirs = new Map(); // dir key -> { dir, watcher | null, files: Map(key -> Set(tab id)) }
	let retryTimer = null;
	const open = new Set(); // every watcher that is really open (the count the tests read)

	const tabOf = (id) => {
		let t = tabs.get(id);
		if (!t) tabs.set(id, (t = { files: new Map(), timer: null }));
		return t;
	};

	function schedule(id) {
		const t = tabs.get(id);
		if (!t) return;
		clearTimeout(t.timer);
		t.timer = setTimeout(() => {
			t.timer = null;
			if (tabs.get(id) === t) onChange(id);
		}, debounceMs);
		if (t.timer.unref) t.timer.unref();
	}

	// What a file looks like on disk: it changed when this does. A watcher also fires for a mere read (last-access time) and for a file's
	// own folder-level noise; a reload reads the page again, so without this check a reload would start the next one.
	function sigOf(d, key) {
		const real = d.names.get(key);
		try {
			const st = fs.statSync(path.join(d.dir, real));
			return `${st.mtimeMs}:${st.size}:${st.ino}`;
		} catch {
			return "gone";
		}
	}
	// A change in `d` (a folder) of the file `name` (null: unknown, so every file there is looked at).
	function event(d, name) {
		const hit = new Set();
		if (brk === "reload-any") {
			for (const ids of d.files.values()) for (const id of ids) hit.add(id);
		} else {
			const keys = name == null ? [...d.files.keys()] : d.files.has(keyOf(String(name))) ? [keyOf(String(name))] : [];
			for (const key of keys) {
				const now = sigOf(d, key);
				if (now === d.sigs.get(key)) continue;
				d.sigs.set(key, now);
				for (const id of d.files.get(key)) hit.add(id);
			}
		}
		for (const id of hit) schedule(id);
	}

	// The identity of a folder on disk (null: not there). A folder that is deleted and made again has another one, so does a link put in
	// its place; a folder that is only renamed away and back has the same.
	const idOf = (dir) => {
		try {
			const st = fs.statSync(dir, { bigint: true });
			return st.isDirectory() ? `${st.dev}:${st.ino}` : null;
		} catch {
			return null;
		}
	};
	// The folder is reached by its own real path (no link on the way): the paths given to add are real ones, so a folder that now resolves
	// somewhere else was replaced by a link, and a link is never followed (it could lead out of the project).
	const isReal = (dir) => {
		try {
			return keyOf((fs.realpathSync.native || fs.realpathSync)(dir)) === keyOf(dir);
		} catch {
			return false;
		}
	};

	function closeWatcher(d) {
		const w = d.watcher;
		if (!w) return;
		d.watcher = null;
		open.delete(w);
		try { w.close(); } catch { /* closed */ }
	}

	function attach(d) {
		if (d.watcher) return true;
		const id = idOf(d.dir);
		if (!id || !isReal(d.dir)) return false;
		let w;
		try {
			w = fs.watch(d.dir, { persistent: false }, (_type, name) => {
				// On Windows a folder that is deleted keeps its old handle: no "error", but an endless stream of events that carry the
				// folder's own full path as the name. Such a name, or a changed identity, means this watcher is dead.
				const n = name == null ? null : String(name);
				if (n != null && (path.isAbsolute(n) || /[\\/]/.test(n))) return lost();
				event(d, n == null ? null : keyOf(n));
			});
		} catch {
			return false;
		}
		const lost = () => {
			if (d.watcher !== w) return;
			d.watcher = null;
			open.delete(w);
			try { w.close(); } catch { /* closed */ }
			if (dirs.get(keyOf(d.dir)) === d) pending();
		};
		w.on("error", lost); // the folder went away: tried again below
		w.on("close", lost);
		d.watcher = w;
		d.id = id;
		open.add(w);
		// The folder may have been replaced between the check and the watch: look once more, a watcher on the old one is no use.
		if (idOf(d.dir) !== id) {
			lost();
			return false;
		}
		return true;
	}

	// Every second while any folder is watched or waiting: a watcher whose folder is gone, or is another folder now (deleted and made
	// again, replaced by a link), is closed and made again; a folder that could not be watched is tried again. When a watcher is back
	// the tabs that use the folder are told it changed (the file may have returned with its folder).
	function pending() {
		if (retryTimer) return;
		retryTimer = setInterval(() => {
			let any = false;
			for (const d of dirs.values()) {
				any = true;
				if (d.watcher && idOf(d.dir) !== d.id) closeWatcher(d);
				if (d.watcher) continue;
				if (attach(d)) event(d, null);
			}
			if (!any) {
				clearInterval(retryTimer);
				retryTimer = null;
			}
		}, RETRY_MS);
		if (retryTimer.unref) retryTimer.unref();
	}

	function release(id, key, real) {
		const dir = path.dirname(real);
		const d = dirs.get(keyOf(dir));
		if (!d) return;
		const ids = d.files.get(key);
		if (ids) {
			ids.delete(id);
			if (!ids.size) {
				d.files.delete(key);
				d.names.delete(key);
				d.sigs.delete(key);
			}
		}
		if (!d.files.size) {
			dirs.delete(keyOf(dir));
			if (brk !== "reload-leak" && d.watcher) {
				const w = d.watcher;
				d.watcher = null;
				open.delete(w);
				try { w.close(); } catch { /* closed */ }
			}
		}
	}

	// Add a file (a real path) to a tab. false when the tab is at its limit.
	function add(id, real) {
		const t = tabOf(id);
		const key = keyOf(path.basename(real));
		const fkey = keyOf(real);
		if (t.files.has(fkey)) return true;
		if (t.files.size >= MAX_FILES) return false;
		t.files.set(fkey, real);
		const dir = path.dirname(real);
		let d = dirs.get(keyOf(dir));
		if (!d) dirs.set(keyOf(dir), (d = { dir, watcher: null, files: new Map(), names: new Map(), sigs: new Map() }));
		let ids = d.files.get(key);
		if (!ids) d.files.set(key, (ids = new Set()));
		ids.add(id);
		d.names.set(key, path.basename(real));
		if (!d.sigs.has(key)) d.sigs.set(key, sigOf(d, key)); // taken now, before the watcher can say anything
		attach(d);
		pending();
		return true;
	}

	// A new page in the tab: its list starts again (and a change that was about to fire is dropped).
	function reset(id) {
		const t = tabs.get(id);
		if (!t) return;
		clearTimeout(t.timer);
		t.timer = null;
		for (const real of t.files.values()) release(id, keyOf(path.basename(real)), real);
		t.files.clear();
	}
	function drop(id) {
		reset(id);
		tabs.delete(id);
	}
	function dropAll() {
		for (const id of [...tabs.keys()]) drop(id);
		if (retryTimer) {
			clearInterval(retryTimer);
			retryTimer = null;
		}
	}

	return {
		MAX_FILES,
		add,
		reset,
		drop,
		dropAll,
		// For the tests and the selftest: how many folders are really watched, which files a tab has, how many a tab has.
		count: () => open.size,
		filesOf: (id) => [...((tabs.get(id) || { files: new Map() }).files.values())],
		has: (id) => !!tabs.get(id),
	};
}

// The page's own file as a path under the REAL project folder (a tab watches it, in its folder), or null. Judged like a request: a file that
// is there must pass project-files isProjectPath (a link that leads out of the project does not); a file that is gone (it may come back)
// is accepted only when the nearest folder that exists is really inside the project, so a link in the project never makes the watcher
// look outside it. `segs`: the project path's segments.
function pageCandidate(root, segs, opts = {}) {
	const fs = opts.fs || nodeFs;
	const path = opts.path || nodePath;
	const files = opts.files || require("./project-files");
	const real = (p) => (fs.realpathSync.native || fs.realpathSync)(p);
	if (!Array.isArray(segs) || !segs.length || segs.some((x) => x === "." || x === ".." || x.startsWith(".") || /[\\:\0]/.test(x))) return null;
	let base;
	try { base = real(root); } catch { return null; }
	const c = path.join(base, ...segs);
	const there = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };
	if (there(c)) return files.isProjectPath(root, c) ? c : null;
	let dir = path.dirname(c);
	while (!there(dir) && dir !== path.dirname(dir)) dir = path.dirname(dir);
	let realDir;
	try { realDir = real(dir); } catch { return null; }
	const rel = path.relative(base, realDir);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel)) ? c : null;
}

module.exports = { create, pageCandidate, MAX_FILES, DEBOUNCE_MS, RETRY_MS };
