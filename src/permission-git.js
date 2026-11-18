// What git will execute or load for a project, read from git itself. Used by the permission-modes extension to grow
// the protected list beyond fixed names (H2 in the third review round).
//
// THE RULE: a file that can make git run code is protected (Allow once / Deny, blocked in Plan) if git would read it for
// this project. That is:
//   1. every git config file in effect (system, global, XDG, repository, worktree), and every file reached through
//      include.path or includeIf.<any condition>.path, followed recursively, active or not, existing or not;
//   2. every hooks folder: the default one and every core.hooksPath value in any of those files;
//   3. every path that any value in those files names (a script that fsmonitor, a textconv, a filter or a hook
//      command runs; core.attributesFile; core.worktree ...). Values are split into words and each word is taken as
//      a path relative to the working tree. alias.* and user.* are skipped: aliases never run for the allowlisted
//      subcommands, and names are not paths.
// Fixed names stay protected in permission-logic.js (.git, .gitattributes, .gitmodules, .husky, .githooks, .pi, HEAD).
// Fail closed: if git's configuration can't be read, { ok: false } and the caller asks for every edit.
"use strict";

const fs = require("fs");
const os = require("os");
const nodePath = require("path");
const { spawnSync } = require("child_process");
const { GIT_HARDEN_GLOBAL } = require("./git-harden");

const MAX_FILES = 200;
const SKIP_VALUE_KEYS = /^(alias|user|author|committer)\./i;
const INCLUDE_KEY = /^(include\.path|includeif\..*\.path)$/i;

function expandHome(p, home) {
	if (p === "~") return home;
	if (/^~[\\/]/.test(p)) return nodePath.join(home, p.slice(2));
	return p;
}

// "origin\0key\nvalue\0" (with --show-origin) or "key\nvalue\0"; a key without a value has no newline.
function parseList(out, withOrigin) {
	const parts = String(out || "").split("\0");
	const rows = [];
	for (let i = 0; i < parts.length; i++) {
		let origin = null;
		if (withOrigin) {
			origin = parts[i];
			i++;
		}
		const rec = parts[i];
		if (rec === undefined || rec === "") continue;
		const nl = rec.indexOf("\n");
		rows.push({ origin, key: nl < 0 ? rec : rec.slice(0, nl), value: nl < 0 ? "" : rec.slice(nl + 1) });
	}
	return rows;
}

// readGitProtection(cwd, { spawn, env, home }) -> { ok, files: [abs], dirs: [abs], root, error? }
function readGitProtection(cwd, opts = {}) {
	const spawn = opts.spawn || spawnSync;
	const env = { ...(opts.env || process.env), GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };
	const home = opts.home || os.homedir();
	const git = (args) => spawn("git", [...GIT_HARDEN_GLOBAL, ...args], { cwd, env, encoding: "utf8", timeout: 8000, windowsHide: true, maxBuffer: 20e6 });
	const files = new Set();
	const dirs = new Set();
	try {
		if (typeof cwd !== "string" || !cwd || !fs.existsSync(cwd)) return { ok: false, files: [], dirs: [], error: "no project folder" };
		const where = git(["rev-parse", "--show-toplevel", "--absolute-git-dir", "--git-common-dir"]);
		if (where.error && where.error.code === "ENOENT") return { ok: true, files: [], dirs: [], root: cwd, nogit: true }; // no git: git runs nothing
		if (where.error) return { ok: false, files: [], dirs: [], error: String(where.error.message || where.error) };
		let root = cwd;
		if (where.status === 0) {
			const [top, gitDir, common] = String(where.stdout).split(/\r?\n/);
			if (top) root = nodePath.resolve(top);
			if (gitDir) {
				const g = nodePath.resolve(gitDir);
				const c = common ? nodePath.resolve(cwd, common) : g; // --git-common-dir is relative to the current folder
				for (const base of new Set([g, c])) {
					files.add(nodePath.join(base, "config"));
					files.add(nodePath.join(base, "config.worktree"));
					dirs.add(nodePath.join(base, "hooks"));
				}
			}
		} else if (!/not a git repository/i.test(String(where.stderr))) {
			return { ok: false, files: [], dirs: [], error: String(where.stderr || "git rev-parse failed").trim() };
		}
		// Global and system files git would read even when they don't exist yet.
		const e = opts.env || process.env;
		const xdg = e.XDG_CONFIG_HOME ? nodePath.join(e.XDG_CONFIG_HOME, "git") : nodePath.join(home, ".config", "git");
		for (const f of [nodePath.join(home, ".gitconfig"), nodePath.join(xdg, "config"), nodePath.join(xdg, "attributes"), e.GIT_CONFIG_GLOBAL, e.GIT_CONFIG_SYSTEM]) if (f) files.add(nodePath.resolve(f));

		// 1. Files in effect (git resolves active includes and tells us where each value came from).
		const listed = git(["config", "--list", "--show-origin", "-z"]);
		if (listed.error || listed.status !== 0) {
			return { ok: false, files: [], dirs: [], error: String((listed.error && listed.error.message) || listed.stderr || "git config failed").trim() };
		}
		const queue = [];
		for (const r of parseList(listed.stdout, true)) {
			if (r.origin && r.origin.startsWith("file:")) queue.push(nodePath.resolve(cwd, r.origin.slice(5)));
		}
		for (const f of [...files]) if (nodePath.basename(f) === "config" || nodePath.basename(f) === ".gitconfig") queue.push(f);

		// 2./3. Read every file raw (no includes), follow every include directive, collect hooks folders and value paths.
		const seen = new Set();
		const values = [];
		while (queue.length) {
			const f = queue.shift();
			const k = process.platform === "win32" ? f.toLowerCase() : f;
			if (seen.has(k)) continue;
			seen.add(k);
			files.add(f);
			if (seen.size > MAX_FILES) return { ok: false, files: [], dirs: [], error: "too many git config includes" };
			if (!fs.existsSync(f)) continue;
			const raw = git(["config", "--file", f, "--list", "--no-includes", "-z"]);
			if (raw.error || raw.status !== 0) return { ok: false, files: [], dirs: [], error: `can't read ${f}: ${String((raw.error && raw.error.message) || raw.stderr).trim()}` };
			for (const r of parseList(raw.stdout, false)) {
				const key = r.key.toLowerCase();
				if (INCLUDE_KEY.test(key)) {
					if (!r.value) continue;
					const target = expandHome(r.value, home);
					queue.push(nodePath.resolve(nodePath.dirname(f), target)); // git: relative to the including file
					continue;
				}
				if (key === "core.hookspath" && r.value) dirs.add(nodePath.resolve(root, expandHome(r.value, home)));
				if (!SKIP_VALUE_KEYS.test(key)) values.push(r.value);
			}
		}
		const rootKey = (p) => (process.platform === "win32" ? p.toLowerCase() : p).replace(/[\\/]+$/, "");
		const ancestors = new Set();
		for (let p = nodePath.resolve(root); ; p = nodePath.dirname(p)) {
			ancestors.add(rootKey(p));
			if (nodePath.dirname(p) === p) break;
		}
		for (const v of values) {
			for (const word of String(v).split(/[\s"'`$();|&<>=,]+/)) {
				if (!word || /^[a-z][a-z0-9+.-]*:\/\//i.test(word)) continue;
				let p;
				try {
					p = nodePath.resolve(root, expandHome(word, home));
				} catch {
					continue;
				}
				if (ancestors.has(rootKey(p))) continue; // "." or ".." would protect everything
				files.add(p);
			}
		}
		return { ok: true, files: [...files], dirs: [...dirs], root };
	} catch (err) {
		return { ok: false, files: [], dirs: [], error: String((err && err.message) || err) };
	}
}

module.exports = { readGitProtection, parseList };
