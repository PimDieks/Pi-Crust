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
// temporary ref first and refuse (exit 2) if an ignored or untracked local file would be overwritten by a public file, check
// out main, and only then swap the remotes. A failed fetch or checkout leaves the clone as it was (said only after checking);
// a failure after the checkout prints the exact state and the commands to finish or go back. Old branches stay (reachable from the bundle too); the old private remote is kept as "private-old".
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

const TMP_REF = "refs/pi-crust-move/public-main";

// Paths the clone has locally but git does not track (ignored or untracked) that the public tree also tracks:
// checkout would silently overwrite them, and the bundle does not contain ignored files.
function collisions(root, tip) {
	const local = new Set();
	for (const args of [
		["ls-files", "-z", "-o", "-i", "--exclude-standard"],
		["ls-files", "-z", "-o", "--exclude-standard"],
	]) {
		for (const f of git(root, args).out.split("\0")) if (f) local.add(f);
	}
	const pub = new Set();
	const pubLower = new Set();
	for (const f of git(root, ["ls-tree", "-r", "-z", "--name-only", tip]).out.split("\0")) {
		if (!f) continue;
		pub.add(f);
		pubLower.add(f.toLowerCase());
		for (let i = f.indexOf("/"); i !== -1; i = f.indexOf("/", i + 1)) pubLower.add(`${f.slice(0, i).toLowerCase()}/`); // directories
	}
	const hit = [];
	for (const f of local) {
		const parts = f.split("/");
		let clash = pubLower.has(f.toLowerCase()) || pubLower.has(`${f.toLowerCase()}/`);
		for (let i = 1; i < parts.length && !clash; i++) clash = pub.has(parts.slice(0, i).join("/")); // local dir where public has a file
		if (clash) hit.push(f);
	}
	return hit.sort();
}

function usage(msg) {
	process.stderr.write(`${msg}\nUsage: node scripts/move-to-public.js [--root DIR] [--public-url URL] [--yes] [--no-install]\n`);
	return 2;
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
		else if (a === "--root" || a === "--public-url") {
			const v = argv[i + 1];
			if (v === undefined || v.startsWith("--")) return usage(`${a} needs a value.`);
			i++;
			if (a === "--root") root = v;
			else publicUrl = v;
		} else return usage(`Unknown option ${a}.`);
	}
	root = path.resolve(root || process.cwd());
	if (!fs.existsSync(root)) refuse(`${root} does not exist.`);
	const top = git(root, ["rev-parse", "--show-toplevel"], { allowFail: true });
	if (!top.ok) refuse(`${root} is not inside a git clone. Go to the clone you want to move, or pass --root DIR.`);
	root = path.resolve(top.out);

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

	// Remote names must be free (or the temp one must already point at the public repo) before anything changes.
	const remotes = git(root, ["remote"]).out.split("\n").filter(Boolean);
	if (remotes.includes(OLD_REMOTE)) refuse(`this clone already has a remote called "${OLD_REMOTE}". Remove or rename it (git remote remove ${OLD_REMOTE}) and run this again. Nothing was changed.`);
	const tmpExists = remotes.includes(TMP_REMOTE);
	if (tmpExists && normUrl(git(root, ["remote", "get-url", TMP_REMOTE]).out) !== normUrl(publicUrl)) {
		refuse(`this clone has a remote called "${TMP_REMOTE}" that points somewhere else. Remove it (git remote remove ${TMP_REMOTE}) and run this again. Nothing was changed.`);
	}

	out(`${yes ? "Moving" : "Dry run, nothing will change. Would move"} ${root}`);
	out(`  now on branch      ${branch}, origin ${state.origin}`);
	out(`  1. back up         git bundle create ${bundle} --all`);
	out(`  2. fetch           ${publicUrl} (main is ${publicTip.slice(0, 8)}) into a temporary ref; refuse if an ignored or untracked local file would be overwritten`);
	out("  3. check out       main from the public main (works with unrelated history; other branches stay)");
	out(`  4. remotes         origin becomes the public repo; the old one is kept as "${OLD_REMOTE}"`);
	out("  5. npm install     only if package-lock.json changed");
	out("  src/local/ and other ignored files are not touched.");
	if (!yes) {
		out("Run again with --yes to do it.");
		return 0;
	}

	const headBefore = git(root, ["rev-parse", "HEAD"]).out;
	const statusBefore = git(root, ["status", "--porcelain", "--untracked-files=all"]).out;
	const returnTo = branch === "(detached HEAD)" ? headBefore : branch;
	const dropTemp = () => {
		git(root, ["update-ref", "-d", TMP_REF], { allowFail: true });
		if (!tmpExists) git(root, ["remote", "remove", TMP_REMOTE], { allowFail: true });
	};

	// 1. Fetch the public tip into a temp ref and look for local files the checkout would overwrite. Nothing else has changed yet.
	try {
		git(root, ["fetch", "--no-tags", publicUrl, `+refs/heads/main:${TMP_REF}`]);
	} catch (e) {
		git(root, ["update-ref", "-d", TMP_REF], { allowFail: true });
		throw new Error(`${e.message}\nNothing was changed.`);
	}
	const clash = collisions(root, TMP_REF);
	if (clash.length) {
		git(root, ["update-ref", "-d", TMP_REF], { allowFail: true });
		const list = clash.slice(0, 20).map((f) => `  ${f}`).join("\n");
		refuse(`${clash.length} local file(s) that git does not track would be overwritten by files in the public repo (ignored files are in no backup):\n${list}${clash.length > 20 ? "\n  ..." : ""}\nMove or rename them (or copy them somewhere safe), then run this again. Nothing was changed.`);
	}

	// 2. Backup. Never overwrite an earlier one.
	let file = bundle;
	for (let n = 2; fs.existsSync(file); n++) file = bundle.replace(/\.bundle$/, `-${n}.bundle`);
	try {
		git(root, ["bundle", "create", file, "--all"]);
		git(root, ["bundle", "verify", file]);
	} catch (e) {
		dropTemp();
		throw new Error(`${e.message}\nNo backup, so nothing was changed.`);
	}
	out(`Backup saved: ${file}`);
	out(`  To restore the old state in a fresh folder: git clone "${file}" restored-clone`);

	// 3. Check out public main. A failure here leaves the clone as it was; verify that instead of assuming it.
	const lockBefore = git(root, ["rev-parse", "HEAD:package-lock.json"], { allowFail: true }).out;
	try {
		if (!tmpExists) git(root, ["remote", "add", TMP_REMOTE, publicUrl]);
		git(root, ["fetch", "--no-tags", TMP_REMOTE, "main"]);
		git(root, ["checkout", "-B", "main", `refs/remotes/${TMP_REMOTE}/main`]);
	} catch (e) {
		dropTemp();
		const headNow = git(root, ["rev-parse", "HEAD"], { allowFail: true }).out;
		const statusNow = git(root, ["status", "--porcelain", "--untracked-files=all"], { allowFail: true }).out;
		const same = headNow === headBefore && statusNow === statusBefore;
		const tail = same
			? `Checked: HEAD (${headBefore.slice(0, 8)}) and the file status are the same as before, so your clone is as it was. The backup is at ${file}.`
			: `Your clone is NOT as it was (HEAD now ${headNow.slice(0, 8) || "unknown"}, was ${headBefore.slice(0, 8)}). To get back: git checkout ${returnTo}, or restore from the backup: git clone "${file}" restored-clone`;
		throw new Error(`${e.message}\n${tail}`);
	}
	// 4. Swap the remotes (renaming also moves the branch upstream settings along). From here on, say exactly where we are on failure.
	const done = [];
	try {
		git(root, ["remote", "rename", "origin", OLD_REMOTE]);
		done.push(`origin renamed to ${OLD_REMOTE}`);
		git(root, ["remote", "rename", TMP_REMOTE, "origin"]);
		done.push(`${TMP_REMOTE} renamed to origin`);
		git(root, ["config", "branch.main.remote", "origin"]);
		git(root, ["config", "branch.main.merge", "refs/heads/main"]);
		done.push("main tracks origin/main");
	} catch (e) {
		const remotesNow = git(root, ["remote", "-v"], { allowFail: true }).out.replace(/\n/g, "\n    ");
		const head = git(root, ["rev-parse", "--short", "HEAD"], { allowFail: true }).out;
		throw new Error(
			`${e.message}\nThe move stopped half way. State: main is checked out from the public repo (${head}); done so far: ${done.join(", ") || "nothing in the remotes"}.\n  Remotes now:\n    ${remotesNow}\n  To finish by hand (skip steps already done):\n    git remote rename origin ${OLD_REMOTE}\n    git remote rename ${TMP_REMOTE} origin\n    git config branch.main.remote origin\n    git config branch.main.merge refs/heads/main\n  To go back instead: git checkout ${returnTo}  (or restore from the backup: git clone "${file}" restored-clone)`,
		);
	}
	git(root, ["update-ref", "-d", TMP_REF], { allowFail: true });
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
