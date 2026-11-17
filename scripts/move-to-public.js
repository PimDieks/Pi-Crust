#!/usr/bin/env node
// Moves an existing clone of the old private Pi Crust repo onto the public repo without losing work.
//   node scripts/move-to-public.js [--root DIR]            dry run: says what would happen, changes nothing
//   node scripts/move-to-public.js [--root DIR] --yes      does the move
// Why a script: the two repos have unrelated histories, so `git pull` refuses ("refusing to merge unrelated histories").
// An old clone does not have this script; run it from a public clone, with --root pointing at the clone to move
// (default: the git clone you are standing in).
// Options: --root DIR, --yes, --public-url URL (default: the public repo), --no-install (skip `npm install`).
// It refuses (exit 2, one line) when the clone has uncommitted or untracked files (src/local/ is ignored, so it is fine),
// commits that exist on no remote, a stash, or when Pi Crust or an update or build is running from that folder.
// A clone whose origin is already the public repo says "already moved" and exits 0.
// The move: bundle everything first (git bundle ..\pi-crust-before-move.bundle --all), fetch the public repo under a
// temporary remote name, check out main from it, and only then swap the remotes. A failed fetch or checkout leaves the
// clone as it was. Old branches stay (reachable from the bundle too); the old private remote is kept as "private-old".
// It never runs reset --hard, clean, checkout -f, push, nor touches stashes or deletes branches.
"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const PUBLIC_URL = "https://github.com/PimDieks/Pi-Crust.git";
const TMP_REMOTE = "pi-crust-public-tmp";
const OLD_REMOTE = "private-old";
const isWin = process.platform === "win32";

const out = (s) => process.stdout.write(`${s}\n`);
class Refuse extends Error {}
const refuse = (why) => {
	throw new Refuse(why);
};

function git(root, args, { allowFail = false } = {}) {
	const r = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 256e6 });
	if (r.error) throw r.error;
	if (r.status !== 0 && !allowFail) throw new Error(`git ${args.join(" ")} failed: ${(r.stderr || r.stdout || "").trim().split("\n").pop()}`);
	return { ok: r.status === 0, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}

// "https://github.com/PimDieks/Pi-Crust.git", "git@github.com:PimDieks/Pi-Crust", a local path ... -> comparable text.
function normUrl(u) {
	let s = String(u || "").trim().replace(/\\/g, "/").replace(/\/+$/, "").replace(/\.git$/i, "");
	s = s.replace(/^git@([^:]+):/, "https://$1/").replace(/^ssh:\/\/git@/, "https://").replace(/^https?:\/\/[^@/]+@/, "https://");
	return s.toLowerCase();
}

function runningFromFolder(root) {
	// Best effort: a process whose command line names this folder and looks like Pi Crust, an update or a build.
	let lines = [];
	try {
		const r = isWin
			? spawnSync("powershell", ["-NoProfile", "-Command", "Get-CimInstance Win32_Process | ForEach-Object { $_.CommandLine }"], { encoding: "utf8", maxBuffer: 64e6 })
			: spawnSync("ps", ["-axo", "command"], { encoding: "utf8", maxBuffer: 64e6 });
		lines = (r.stdout || "").split(/\r?\n/);
	} catch {
		return false;
	}
	const needle = path.resolve(root).toLowerCase();
	return lines.some((l) => {
		const t = l.toLowerCase().replace(/\\\\/g, "\\");
		return t.includes(needle) && /electron|scripts[\\/](update|dist-win|dist-mac)\.js|electron-builder/.test(t) && !/move-to-public/.test(t);
	});
}

function check(root, publicUrl) {
	const top = git(root, ["rev-parse", "--show-toplevel"], { allowFail: true });
	if (!top.ok) refuse(`${root} is not a git clone.`);
	const origin = git(root, ["remote", "get-url", "origin"], { allowFail: true });
	if (origin.ok && normUrl(origin.out) === normUrl(publicUrl)) return { moved: true };
	if (!origin.ok) refuse("this clone has no remote called origin, so I cannot tell what it was cloned from.");

	const dirty = git(root, ["status", "--porcelain", "--untracked-files=all", "--", ".", ":(exclude)src/local"]).out;
	if (dirty) refuse(`the clone has uncommitted or untracked files (${dirty.split("\n").length}, first: ${dirty.split("\n")[0].trim()}). Commit them (and push), or move them away, then run this again.`);

	const unpushed = git(root, ["rev-list", "--branches", "HEAD", "--not", "--remotes"], { allowFail: true }).out;
	if (unpushed) refuse(`${unpushed.split("\n").length} commit(s) exist on no remote. Push them to the old repo (or tell someone) first so they are not lost.`);

	if (git(root, ["stash", "list"]).out) refuse("the clone has a stash. Apply or commit it first (this script does not touch stashes).");
	if (runningFromFolder(root)) refuse("Pi Crust, an update or a build seems to be running from this folder. Quit it first.");
	return { moved: false, origin: origin.out };
}

function main(argv) {
	let root = null;
	let publicUrl = PUBLIC_URL;
	let yes = false;
	let install = true;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--yes") yes = true;
		else if (a === "--no-install") install = false;
		else if (a === "--root") root = argv[++i];
		else if (a === "--public-url") publicUrl = argv[++i];
		else {
			process.stderr.write(`Unknown option ${a}. Use --root DIR, --yes, --public-url URL, --no-install.\n`);
			return 2;
		}
	}
	if (!root) {
		const t = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
		if (t.status !== 0) refuse("you are not inside a git clone. Go to the clone you want to move, or pass --root DIR.");
		root = t.stdout.trim();
	}
	root = path.resolve(root);
	if (!fs.existsSync(root)) refuse(`${root} does not exist.`);

	const state = check(root, publicUrl);
	if (state.moved) {
		out("Already moved: origin is already the public repo.");
		return 0;
	}

	const branch = git(root, ["branch", "--show-current"]).out || "(detached HEAD)";
	const bundle = path.join(path.dirname(root), "pi-crust-before-move.bundle");
	const target = git(root, ["ls-remote", publicUrl, "refs/heads/main"], { allowFail: true });
	if (!target.ok || !target.out) refuse(`cannot reach the public repo at ${publicUrl} (${target.err.split("\n").pop() || "no main branch"}). Nothing was changed.`);
	const publicTip = target.out.split(/\s+/)[0];

	out(`${yes ? "Moving" : "Dry run, nothing will change. Would move"} ${root}`);
	out(`  now on branch      ${branch}, origin ${state.origin}`);
	out(`  1. back up         git bundle create ${bundle} --all`);
	out(`  2. fetch           ${publicUrl} (main is ${publicTip.slice(0, 8)}) under a temporary remote`);
	out("  3. check out       main from the public main (works with unrelated history; other branches stay)");
	out(`  4. remotes         origin becomes the public repo; the old one is kept as "${OLD_REMOTE}"`);
	out("  5. npm install     only if package-lock.json changed");
	out("  src/local/ and other ignored files are not touched.");
	if (!yes) {
		out("Run again with --yes to do it.");
		return 0;
	}

	// 1. Backup. Never overwrite an earlier one.
	let file = bundle;
	for (let n = 2; fs.existsSync(file); n++) file = bundle.replace(/\.bundle$/, `-${n}.bundle`);
	git(root, ["bundle", "create", file, "--all"]);
	git(root, ["bundle", "verify", file]);
	out(`Backup saved: ${file}`);

	// 2-3. Fetch under a temporary name and check out. A failure here leaves the clone as it was (minus the temp remote).
	const lockBefore = git(root, ["rev-parse", "HEAD:package-lock.json"], { allowFail: true }).out;
	git(root, ["remote", "remove", TMP_REMOTE], { allowFail: true });
	git(root, ["remote", "add", TMP_REMOTE, publicUrl]);
	try {
		git(root, ["fetch", TMP_REMOTE, "main"]);
		git(root, ["checkout", "-B", "main", `refs/remotes/${TMP_REMOTE}/main`]);
	} catch (e) {
		git(root, ["remote", "remove", TMP_REMOTE], { allowFail: true });
		throw new Error(`${e.message}\nNothing was moved; your clone is as it was. The backup is at ${file}.`);
	}
	// 4. Swap the remotes (renaming also moves the branch upstream settings along).
	git(root, ["remote", "rename", "origin", OLD_REMOTE]);
	git(root, ["remote", "rename", TMP_REMOTE, "origin"]);
	git(root, ["config", "branch.main.remote", "origin"]);
	git(root, ["config", "branch.main.merge", "refs/heads/main"]);
	out(`Now on main = public ${git(root, ["rev-parse", "--short", "HEAD"]).out}. The old repo is kept as remote "${OLD_REMOTE}".`);

	// 5. Dependencies.
	const lockAfter = git(root, ["rev-parse", "HEAD:package-lock.json"], { allowFail: true }).out;
	if (lockBefore !== lockAfter) {
		if (!install) out("package-lock.json changed: run `npm install` before starting Pi Crust.");
		else {
			out("package-lock.json changed: running npm install...");
			const r = spawnSync(isWin ? "npm.cmd" : "npm", ["install"], { cwd: root, stdio: "inherit", shell: isWin });
			if (r.status !== 0) out("npm install did not finish. Run `npm install` in the folder before starting Pi Crust.");
		}
	}
	out("Done. Restart Pi Crust.");
	return 0;
}

if (require.main === module) {
	try {
		process.exitCode = main(process.argv.slice(2));
	} catch (e) {
		if (e instanceof Refuse) {
			process.stderr.write(`Not moved: ${e.message}\n`);
			process.exitCode = 2;
		} else {
			process.stderr.write(`move-to-public failed: ${e.message}\n`);
			process.exitCode = 1;
		}
	}
}

module.exports = { normUrl };
