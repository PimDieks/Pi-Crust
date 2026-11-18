// "Make it a Git project" (the Project row of the welcome view): `git init` in the open folder, nothing else.
// Never adds, commits or configures anything. The folder is always the one the app has open (never taken from the window), and a
// folder that already sits inside a Git project is left alone: the message says so instead of nesting a second repo in it.
//  - initGit(repo, { exec, fs, env }) -> { ok, already?, error? }
//  - IPC: repos:initGit -> the same. In a selftest nothing is run at all ({ ok: true, selftest: true }).
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { usualDirs, withDirs } = require("./health-main");

function run(cmd, args, opts) {
	return new Promise((resolve) => {
		execFile(cmd, args, { windowsHide: true, timeout: 20_000, ...opts }, (err, stdout, stderr) => resolve({ ok: !err, errCode: err && typeof err.code === "string" ? err.code : null, stdout: String(stdout || ""), stderr: String(stderr || "") }));
	});
}

// The folder that holds the `.git` (a folder, or a file in a linked worktree) of `repo` or of a folder above it, or null.
function gitRootOf(repo, fsx = fs) {
	for (let dir = path.resolve(repo), prev = null; dir !== prev; prev = dir, dir = path.dirname(dir)) {
		try {
			if (fsx.existsSync(path.join(dir, ".git"))) return dir;
		} catch {}
	}
	return null;
}

async function initGit(repo, { exec = run, fs: fsx = fs, env = process.env, platform = process.platform, home = require("node:os").homedir() } = {}) {
	if (!repo) return { ok: false, error: "No folder is open." };
	try {
		if (!fsx.statSync(repo).isDirectory()) return { ok: false, error: "That folder can't be read." };
	} catch {
		return { ok: false, error: "That folder can't be read." };
	}
	const root = gitRootOf(repo, fsx);
	if (root) {
		if (path.resolve(root) === path.resolve(repo)) return { ok: true, already: true }; // a second run changes nothing
		return { ok: false, error: `This folder is already inside a Git project (${root}). Open that folder instead.` };
	}
	const dirs = usualDirs(platform, env, home).git;
	const e = withDirs(env, dirs, fsx, path.delimiter);
	const r = await exec("git", ["init"], { cwd: repo, env: e });
	if (r.errCode === "ENOENT") return { ok: false, error: "Git isn't installed yet. Install it first." };
	if (!r.ok) return { ok: false, error: `Git couldn't set up this folder. ${String(r.stderr).trim().split(/\r?\n/)[0] || ""}`.trim() };
	return fsx.existsSync(path.join(repo, ".git")) ? { ok: true, already: false } : { ok: false, error: "Git said it finished, but the folder has no .git." };
}

function register(ctx) {
	ctx.ipcMain.handle("repos:initGit", async () => {
		if (ctx.selftest === true) return { ok: true, selftest: true }; // a test run never changes a folder
		return initGit(ctx.repo, { env: ctx.env });
	});
}

module.exports = { register, initGit, gitRootOf };
