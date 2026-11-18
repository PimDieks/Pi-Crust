// "Make it a Git project" (the Project row of the welcome view): `git init` in the open folder, nothing else.
// Never adds, commits or configures anything. The folder is always the one the app has open (never taken from the window), and a
// folder that already sits inside a Git project is left alone: the message says so instead of nesting a second repo in it.
// The confirm is enforced here: repos:initGitPlan returns the folder and a one-time token bound to that exact folder, and
// repos:initGit needs the token (and the app must still have that folder open). A call without a valid token does nothing.
// Git runs from a neutral folder (the temp folder) as `git -C <folder> init`, by the absolute path the health check found, so a
// git.exe lying in the project can never be the one that runs. The home folder and a drive root are refused.
//  - initGit(repo, { exec, fs, env, gitPath }) -> { ok, already?, error? }
//  - IPC: repos:initGitPlan -> { ok, folder, token, error? }; repos:initGit({ token }) -> the initGit result. In a selftest nothing is run.
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
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

// Folders that must never become a Git project by a button: the home folder and the top of a drive.
function refusedFolder(repo, { home = os.homedir(), platform = process.platform } = {}) {
	const norm = (p) => {
		const r = path.resolve(p).replace(/[\\/]+$/, "");
		return platform === "win32" ? r.toLowerCase() : r;
	};
	const abs = path.resolve(repo);
	if (path.parse(abs).root === abs || norm(abs) === "") return "That is the top of a drive. Open your project folder instead.";
	if (home && norm(abs) === norm(home)) return "That is your home folder. Open your project folder instead.";
	return null;
}

// Checks shared by the confirm and the run: { ok: false, error } or { ok: true, already? }.
function checkFolder(repo, { fs: fsx = fs, home, platform } = {}) {
	if (!repo) return { ok: false, error: "No folder is open." };
	try {
		if (!fsx.statSync(repo).isDirectory()) return { ok: false, error: "That folder can't be read." };
	} catch {
		return { ok: false, error: "That folder can't be read." };
	}
	const refused = refusedFolder(repo, { home, platform });
	if (refused) return { ok: false, error: refused };
	const root = gitRootOf(repo, fsx);
	if (root) {
		if (path.resolve(root) === path.resolve(repo)) return { ok: true, already: true }; // a second run changes nothing
		return { ok: false, error: `This folder is already inside a Git project (${root}). Open that folder instead.` };
	}
	return { ok: true };
}

async function initGit(repo, { exec = run, fs: fsx = fs, env = process.env, platform = process.platform, home = os.homedir(), gitPath = null, cwd = os.tmpdir() } = {}) {
	const c = checkFolder(repo, { fs: fsx, home, platform });
	if (!c.ok) return c;
	if (c.already) return { ok: true, already: true };
	const dirs = usualDirs(platform, env, home).git;
	const e = withDirs(env, dirs, fsx, path.delimiter);
	// The health check's Git, by its absolute path. Nothing found there: Git isn't installed (a bare "git" is never tried).
	if (!gitPath) return { ok: false, error: "Git isn't installed yet. Install it first." };
	const r = await exec(gitPath, ["-C", repo, "init"], { cwd, env: e });
	if (r.errCode === "ENOENT") return { ok: false, error: "Git isn't installed yet. Install it first." };
	if (!r.ok) return { ok: false, error: `Git couldn't set up this folder. ${String(r.stderr).trim().split(/\r?\n/)[0] || ""}`.trim() };
	return fsx.existsSync(path.join(repo, ".git")) ? { ok: true, already: false } : { ok: false, error: "Git said it finished, but the folder has no .git." };
}

// The IPC handlers, dependencies replaceable for tests: { init, newToken, gitPath: async () => path|null }.
function createHandlers(ctx, { init = initGit, newToken = () => crypto.randomBytes(16).toString("hex"), gitPath = async () => (await ctx.health?.detectGit?.())?.path || null, check = checkFolder } = {}) {
	let pending = null; // { token, folder }
	return {
		// The folder the confirm will name, and the token that lets `git init` run in exactly that folder, once.
		async plan() {
			const folder = ctx.repo;
			// A test run never changes a folder, so it asks for the confirm whatever the real folder is.
			const c = ctx.selftest === true ? (folder ? { ok: true } : { ok: false, error: "No folder is open." }) : check(folder);
			if (!c.ok) return (pending = null), { ok: false, folder: folder || null, error: c.error };
			if (c.already) return (pending = null), { ok: false, folder, already: true, error: "This folder is already a Git project." };
			pending = { token: newToken(), folder };
			return { ok: true, folder, token: pending.token };
		},
		async init(_e, o) {
			const p = pending;
			if (!p || !o || typeof o.token !== "string" || o.token !== p.token) return { ok: false, error: "Nothing was confirmed. Choose Make it a Git project again.", noToken: true };
			pending = null; // one time only
			if (ctx.repo !== p.folder) return { ok: false, error: "The open folder changed since you confirmed. Choose Make it a Git project again.", changed: true };
			if (ctx.selftest === true) return { ok: true, selftest: true }; // a test run never changes a folder
			return init(p.folder, { env: ctx.env, gitPath: await gitPath() });
		},
	};
}

function register(ctx) {
	const h = createHandlers(ctx);
	ctx.ipcMain.handle("repos:initGitPlan", h.plan);
	ctx.ipcMain.handle("repos:initGit", h.init);
	return h;
}

module.exports = { register, createHandlers, initGit, gitRootOf, refusedFolder, checkFolder };
