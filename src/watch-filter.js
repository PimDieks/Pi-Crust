// Which file changes are build noise, and a debounce that can't be postponed forever.
"use strict";
const { createTtlCache } = require("./ttl-cache");
const { hardenGitArgs } = require("./git-harden");

// Folder names that are noise anywhere in a path (the tree listing keeps its own, shorter set).
const NOISE_DIRS = new Set([".git", "node_modules", ".turbo", ".next", ".vite", "coverage", "storybook-static", ".DS_Store", "__generated__"]);
// Build output folders: also real source folders in some repos (src/build, packages/out), so they count as noise only
// when git ignores them (isIgnored(dirRel)), or, outside a git repo, never except `dist`.
const BUILD_DIRS = new Set(["dist", "out", "build"]);
const NOISE_SUFFIXES = [".tsbuildinfo", ".log"];

// `rel` is a path relative to the repo root, with / or \ separators. Git state is judged by the caller.
// isIgnored(dirRel) -> bool tells whether a folder is gitignored (default: only `dist` is trusted to be build output).
function isNoise(rel, isIgnored = (dir) => dir.split("/").pop() === "dist") {
	const parts = rel.split(/[\\/]/);
	for (let i = 0; i < parts.length; i++) {
		if (NOISE_DIRS.has(parts[i])) return true;
		if (BUILD_DIRS.has(parts[i]) && isIgnored(parts.slice(0, i + 1).join("/"))) return true;
	}
	const last = parts[parts.length - 1];
	return NOISE_SUFFIXES.some((s) => last.endsWith(s));
}

// isIgnored for a repo/worktree folder: asks `git check-ignore` once per folder and remembers the answer for a while.
// Tracked folders are never reported as ignored, so a committed `build/` is still watched.
function createIgnoreCheck(root, { spawnSync, ttlMs = 30_000, now = Date.now } = {}) {
	const cache = createTtlCache(ttlMs, now);
	return (dirRel) => {
		dirRel = dirRel.replace(/\\/g, "/");
		if (cache.has(dirRel)) return cache.get(dirRel);
		let ignored;
		const r = spawnSync("git", hardenGitArgs(["check-ignore", "-q", "--", dirRel + "/"], { cwd: root }), { cwd: root, timeout: 3000, windowsHide: true });
		if (r.status === 0) ignored = true;
		else if (r.status === 1) ignored = false;
		else ignored = dirRel.split("/").pop() === "dist"; // not a git repo, or git failed
		cache.set(dirRel, ignored);
		return ignored;
	};
}

// Trailing debounce: fires `wait` ms after the last call, but at least every `maxWait` ms under continuous calls.
function debounceMax(fn, wait, maxWait, timers = { setTimeout, clearTimeout, now: Date.now }) {
	let timer = null;
	let first = 0;
	const fire = () => {
		timers.clearTimeout(timer);
		timer = null;
		fn();
	};
	return () => {
		const now = timers.now();
		if (timer === null) first = now;
		else timers.clearTimeout(timer);
		timer = timers.setTimeout(fire, Math.max(0, Math.min(wait, first + maxWait - now)));
	};
}

module.exports = { NOISE_DIRS, BUILD_DIRS, isNoise, createIgnoreCheck, debounceMax };
