// Git worktrees for chats ("New chat in worktree…"): a chat can work in its own checkout of the repo on its own branch, so
// several chats edit in parallel without touching each other or your main checkout.
//  - worktree:create({ branch })  -> git worktree add -b <branch> <userData>/worktrees/<sha1(repo)>/<slug> HEAD
//  - worktree:list / worktree:status(cwd) / worktree:remove({ cwd, force })   (the branch is always kept)
// Every cwd from the UI is checked against `git worktree list --porcelain` before it is used (see findWorktree).
"use strict";

const { execFile, execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { hardenGitArgs } = require("./git-harden");

const sha1 = (s) => crypto.createHash("sha1").update(s).digest("hex");
const real = (p) => {
	try {
		return fs.realpathSync.native(p);
	} catch {
		return path.resolve(p);
	}
};

// `git worktree list --porcelain` -> [{ path, head, branch | null, detached, bare, locked }]
function parsePorcelain(text) {
	const out = [];
	for (const block of String(text || "").split(/\n\n+/)) {
		const wt = { path: "", head: "", branch: null, detached: false, bare: false, locked: false };
		for (const line of block.split("\n")) {
			if (line.startsWith("worktree ")) wt.path = line.slice(9);
			else if (line.startsWith("HEAD ")) wt.head = line.slice(5);
			else if (line.startsWith("branch ")) wt.branch = line.slice(7).replace(/^refs\/heads\//, "");
			else if (line === "detached") wt.detached = true;
			else if (line === "bare") wt.bare = true;
			else if (line.startsWith("locked")) wt.locked = true;
		}
		if (wt.path) out.push(wt);
	}
	return out;
}

function listWorktrees(repo, env) {
	return new Promise((resolve) => {
		execFile("git", hardenGitArgs(["worktree", "list", "--porcelain"], { cwd: repo }), { cwd: repo, env, maxBuffer: 5e6, windowsHide: true }, (err, out) => resolve(err ? [] : parsePorcelain(out)));
	});
}

// `git worktree list` is cached for ~2 s (many handlers ask per call); create/remove invalidate it.
const cache = new Map(); // repo -> { at, p }
const invalidate = (repo) => cache.delete(repo);
function listCached(repo, env) {
	const c = cache.get(repo);
	if (c && Date.now() - c.at < 2000) return c.p;
	const p = listWorktrees(repo, env);
	cache.set(repo, { at: Date.now(), p });
	return p;
}

// The worktree at `cwd` if it is a linked worktree of `repo` (not the main checkout itself), else null. Async, cached.
async function findWorktree(repo, env, cwd) {
	if (!repo || typeof cwd !== "string" || !cwd) return null;
	const want = real(cwd);
	if (want === real(repo)) return null;
	return (await listCached(repo, env)).find((w) => !w.bare && real(w.path) === want && real(w.path) !== real(repo)) || null;
}

// The admin dir of a linked worktree (.git is a file "gitdir: …"). The Pi-Crust marker lives there, not in the working tree.
function adminDir(dir) {
	try {
		const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(path.join(dir, ".git"), "utf8"));
		return m ? path.resolve(dir, m[1].trim()) : null;
	} catch {
		return null;
	}
}
const MARKER = ".pi-crust-managed";

const slugOf = (branch) => branch.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "worktree";

function register(ctx) {
	const { ipcMain } = ctx;
	const base = () => path.join(ctx.app.getPath("userData"), "worktrees", sha1(ctx.repo));
	const git = (args, opts = {}) => ctx.run("git", args, { cwd: ctx.repo, ...opts }); // always the main checkout
	const known = (cwd) => findWorktree(ctx.repo, ctx.env, cwd);
	// Only worktrees Pi Crust made: under base() (by realpath) and carrying the marker. Anything else is never removed by us.
	const managed = (wt) => {
		if (!wt) return false;
		const b = real(base());
		const p = real(wt.path);
		const admin = adminDir(wt.path);
		return p.startsWith(b + path.sep) && !!admin && fs.existsSync(path.join(admin, MARKER));
	};

	ipcMain.handle("worktree:create", async (_e, o) => {
		if (!ctx.repo) return { ok: false, error: "Open a repo first" };
		let branch = String((o && o.branch) || "").trim();
		if (!branch) return { ok: false, error: "Enter a branch name" };
		const checked = branch.startsWith("-") ? { ok: false } : await git(["check-ref-format", "--branch", branch]);
		if (!checked.ok || !checked.stdout.trim()) return { ok: false, error: `“${branch}” is not a valid branch name` };
		branch = checked.stdout.trim(); // git's normalized name
		if ((await git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])).ok) return { ok: false, error: `The branch “${branch}” already exists` };
		if (!(await git(["rev-parse", "--verify", "HEAD"])).ok) return { ok: false, error: "The repo has no commits yet" };
		fs.mkdirSync(base(), { recursive: true });
		let dir = path.join(base(), slugOf(branch));
		for (let n = 2; fs.existsSync(dir); n++) dir = path.join(base(), `${slugOf(branch)}-${n}`);
		const r = await git(["worktree", "add", "-b", branch, dir, "HEAD"], { timeout: 120_000 });
		invalidate(ctx.repo);
		if (!r.ok) return { ok: false, error: r.stderr.trim() || "git worktree add failed" };
		const admin = adminDir(dir);
		try {
			if (admin) fs.writeFileSync(path.join(admin, MARKER), "pi-crust\n");
		} catch {}
		const pm = fs.existsSync(path.join(ctx.repo, "pnpm-lock.yaml")) ? "pnpm" : fs.existsSync(path.join(ctx.repo, "yarn.lock")) ? "yarn" : "npm";
		const needsInstall = fs.existsSync(path.join(dir, "package.json")) && fs.existsSync(path.join(ctx.repo, "node_modules"));
		return { ok: true, cwd: dir, branch, installCmd: needsInstall ? `${pm} install` : null };
	});

	ipcMain.handle("worktree:list", async () => {
		if (!ctx.repo) return [];
		return (await listCached(ctx.repo, ctx.env)).filter((w) => !w.bare && real(w.path) !== real(ctx.repo)).map((w) => ({ ...w, managed: managed(w) }));
	});

	// { ok, dirty, changes } for the "remove the worktree?" question.
	ipcMain.handle("worktree:status", async (_e, cwd) => {
		const wt = await known(cwd);
		if (!wt) return { ok: false, error: "Not a worktree of this repo" };
		const r = await ctx.run("git", hardenGitArgs(["status", "--porcelain"], { cwd: wt.path }), { cwd: wt.path });
		const changes = r.stdout.split("\n").filter(Boolean).length;
		return { ok: r.ok, dirty: changes > 0, changes, branch: wt.branch, managed: managed(wt) };
	});

	// Removes the checkout folder only; the branch stays.
	ipcMain.handle("worktree:remove", async (_e, o) => {
		const wt = await known(o && o.cwd);
		if (!wt) return { ok: false, error: "Not a worktree of this repo" };
		if (!managed(wt)) return { ok: false, error: "Not a worktree made by Pi Crust; remove it with git yourself" };
		const args = ["worktree", "remove", ...(o.force ? ["--force"] : []), wt.path];
		const r = await git(args, { timeout: 120_000 });
		invalidate(ctx.repo);
		if (!r.ok) return { ok: false, error: r.stderr.trim() || "git worktree remove failed", dirty: /modified or untracked|contains modified/i.test(r.stderr) };
		await git(["worktree", "prune"]);
		invalidate(ctx.repo);
		try {
			fs.rmdirSync(base()); // only when it is empty
		} catch {}
		return { ok: true, branch: wt.branch };
	});

	if (ctx.selftest) {
		// Self-test helpers: nothing here touches anything but pi/selftest-* branches and the given worktree.
		ipcMain.handle("worktree:selftestInfo", (_e, chatId) => {
			const info = ctx.chatInfo(chatId);
			if (!info) return null;
			let procCwd = null; // null = unknown: Windows has no lsof, and the self-test then skips that check
			if (process.platform !== "win32") {
				try {
					const out = execFileSync("lsof", ["-a", "-p", String(info.pid), "-d", "cwd", "-Fn"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
					procCwd = (out.split("\n").find((l) => l.startsWith("n")) || "").slice(1) || null;
				} catch {}
			}
			return { ...info, procCwd };
		});
		ipcMain.handle("worktree:selftestWrite", async (_e, cwd, name, text) => {
			const wt = await known(cwd);
			if (!wt || !/^[\w.-]+$/.test(String(name))) return false;
			fs.writeFileSync(path.join(wt.path, name), String(text));
			return true;
		});
		ipcMain.handle("worktree:selftestDeleteBranch", async (_e, branch) => {
			if (!/^pi\/selftest-[\w-]+$/.test(String(branch))) return { ok: false, error: "refused" };
			return git(["branch", "-D", branch]);
		});
		ipcMain.handle("worktree:selftestExists", (_e, cwd) => fs.existsSync(String(cwd)));
	}
}

module.exports = { register, findWorktree, listWorktrees, invalidate, MARKER, parsePorcelain, slugOf };
