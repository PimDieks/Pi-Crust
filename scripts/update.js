#!/usr/bin/env node
// Update Pi Crust from GitHub: `npm run update` (or `node scripts/update.js`). The Update button in the app runs
// this too (src/update-main.js).
// 1. Pulls the current branch (fast-forward only; refuses when you have uncommitted changes to tracked files).
// 2. Runs `npm install` when package.json or package-lock.json changed (or node_modules is missing).
// 3. macOS/Linux: rebuilds node-pty for Electron after an install. Windows: fetches electron.exe if npm skipped it.
// 4. Windows: when the installed app (%LOCALAPPDATA%\Programs\Pi Crust) exists, rebuilds the installer and runs it
//    silently so the installed copy is updated too. Skip that with --no-app; force it with --app.
//    macOS: the same for an installed Pi Crust.app (/Applications or ~/Applications): rebuilds it and swaps it in
//    (scripts/mac-install-app.sh; when Pi Crust is running, once it quits). --app installs it the first time.
// Flags: --check (only report whether an update is available), --force (reinstall deps even if nothing changed),
// --no-run (build, then print "INSTALLER=<path>" (Windows) or "APP=<path>" (macOS) instead of installing; the app
// installs it after quitting).
"use strict";
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const args = new Set(process.argv.slice(2));
const isWin = process.platform === "win32";
const isMac = process.platform === "darwin";
// When the app runs this script it uses its own Electron as Node (ELECTRON_RUN_AS_NODE=1). npm and git must not
// inherit that; our own Node children (process.execPath) need it.
const asNode = process.env.ELECTRON_RUN_AS_NODE;
delete process.env.ELECTRON_RUN_AS_NODE;

function run(cmd, cmdArgs, opts = {}) {
	// npm/npx are .cmd files on Windows and need a shell; their args here are fixed strings, so joining them is safe.
	const shell = isWin && /^(npm|npx)$/.test(cmd);
	const env = opts.node && asNode ? { ...process.env, ELECTRON_RUN_AS_NODE: asNode } : process.env;
	const o = { cwd: root, stdio: opts.capture ? "pipe" : "inherit", encoding: "utf8", shell, env, windowsHide: true };
	const r = shell ? spawnSync([cmd, ...cmdArgs].join(" "), o) : spawnSync(opts.node ? process.execPath : cmd, cmdArgs, o);
	if (r.error) throw r.error;
	if (r.status !== 0 && !opts.allowFail) {
		const msg = opts.capture ? (r.stderr || r.stdout || "").trim() : "";
		throw new Error(`${cmd} ${cmdArgs.join(" ")} failed${msg ? `:\n${msg}` : ""}`);
	}
	return opts.capture ? (r.stdout || "").trim() : r.status;
}
const git = (...a) => run("git", a, { capture: true });
const say = (s) => console.log(`[pi-crust update] ${s}`);

function main() {
	if (!fs.existsSync(path.join(root, ".git"))) throw new Error(`${root} is not a git clone. Clone https://github.com/PimDieks/Pi-Crust to get updates.`);
	const branch = git("rev-parse", "--abbrev-ref", "HEAD");
	const upstream = run("git", ["rev-parse", "--abbrev-ref", "@{u}"], { capture: true, allowFail: true });
	if (!upstream) throw new Error(`Branch "${branch}" has no upstream. Run: git branch --set-upstream-to=origin/main`);

	say(`Fetching ${upstream}…`);
	run("git", ["fetch", "--quiet"]);
	const before = git("rev-parse", "HEAD");
	const remote = git("rev-parse", "@{u}");
	const behind = Number(git("rev-list", "--count", "HEAD..@{u}"));
	const ahead = Number(git("rev-list", "--count", "@{u}..HEAD"));

	if (args.has("--check")) {
		say(behind ? `${behind} new commit(s) on ${upstream}:` : "Up to date.");
		if (behind) console.log(git("log", "--oneline", "HEAD..@{u}"));
		return;
	}

	let changed = [];
	if (behind) {
		const dirty = git("status", "--porcelain", "--untracked-files=no");
		if (dirty) throw new Error(`You have uncommitted changes in ${root}, so nothing was pulled:\n${dirty}\nCommit or stash them (git stash), then update again.`);
		if (ahead) throw new Error(`Your branch has ${ahead} local commit(s) that are not on ${upstream}. Push or rebase them first (git pull --rebase).`);
		say(`Pulling ${behind} new commit(s)…`);
		run("git", ["merge", "--ff-only", "--quiet", remote]);
		changed = git("diff", "--name-only", before, "HEAD").split(/\r?\n/).filter(Boolean);
		console.log(git("log", "--oneline", `${before}..HEAD`));
	} else {
		say(`Already up to date with ${upstream}.`);
	}

	const depsChanged = changed.some((f) => f === "package.json" || f === "package-lock.json");
	const noModules = !fs.existsSync(path.join(root, "node_modules"));
	if (depsChanged || noModules || args.has("--force")) {
		say("Installing dependencies…");
		run("npm", ["install", "--no-fund", "--no-audit"]);
		if (!isWin) {
			say("Rebuilding node-pty for Electron…");
			run("npx", ["--no-install", "electron-rebuild", "-f", "-w", "node-pty"]);
		}
	}
	if (isWin && !fs.existsSync(path.join(root, "node_modules", "electron", "dist", "electron.exe"))) {
		say("Downloading Electron (npm skipped its install script)…");
		run("node", [path.join("node_modules", "electron", "install.js")], { node: true });
	}

	if (isWin && !args.has("--no-app")) {
		const installed = path.join(process.env.LOCALAPPDATA || "", "Programs", "Pi Crust", "Pi Crust.exe");
		if ((fs.existsSync(installed) && (changed.length || args.has("--force"))) || args.has("--app")) updateWindowsApp();
	}
	if (isMac && !args.has("--no-app")) {
		const dest = macAppTarget();
		if ((dest.built && (changed.length || args.has("--force"))) || args.has("--app")) updateMacApp(dest.path);
	}

	if ((changed.length || args.has("--force")) && !args.has("--no-run")) say("Done. Restart Pi Crust to use the new version.");
}

function updateWindowsApp() {
	say("Building the Windows installer…");
	run("node", [path.join("scripts", "dist-win.js")], { node: true });
	const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
	const setup = path.join(root, "dist", `Pi-Crust-Setup-${version}.exe`);
	if (!fs.existsSync(setup)) throw new Error(`Installer not found at ${setup}`);
	if (args.has("--no-run")) return console.log(`INSTALLER=${setup}`);
	say("Installing the update (Pi Crust is closed if it is running, and started again afterwards)…");
	// --updated: give a running Pi Crust a moment to exit; --force-run: start the new version when done.
	run(setup, ["/S", "--updated", "--force-run"]);
}

// Where Pi Crust.app is (or goes): an app built by dist-mac.js first, then any Pi Crust.app (e.g. one made by hand),
// else /Applications when writable, else ~/Applications.
function macAppTarget() {
	const dirs = ["/Applications", path.join(require("os").homedir(), "Applications")];
	const apps = dirs.map((d) => path.join(d, "Pi Crust.app")).filter((a) => fs.existsSync(a));
	const built = apps.find((a) => fs.existsSync(path.join(a, "Contents", "MacOS", "Pi Crust")));
	if (built) return { path: built, built: true };
	if (apps.length) return { path: apps[0], built: false };
	let writable = false;
	try {
		fs.accessSync(dirs[0], fs.constants.W_OK);
		writable = true;
	} catch {}
	return { path: path.join(writable ? dirs[0] : dirs[1], "Pi Crust.app"), built: false };
}

function updateMacApp(dest) {
	say("Building Pi Crust.app…");
	run("node", [path.join("scripts", "dist-mac.js"), "--dir"], { node: true });
	const outDir = path.join(root, "dist", process.arch === "arm64" ? "mac-arm64" : "mac");
	const app = path.join(outDir, "Pi Crust.app");
	if (!fs.existsSync(app)) throw new Error(`Built app not found at ${app}`);
	if (args.has("--no-run")) return console.log(`APP=${app}`);
	const script = path.join(root, "scripts", "mac-install-app.sh");
	// The running Pi Crust (its main process is called exactly "Pi Crust"): install once it has quit.
	const pid = run("pgrep", ["-x", "Pi Crust"], { capture: true, allowFail: true }).split(/\s+/)[0];
	if (pid) {
		require("child_process").spawn("/bin/sh", [script, app, dest, pid], { detached: true, stdio: "ignore" }).unref();
		say(`Pi Crust is running: the new version is installed in ${dest} when you quit it.`);
	} else {
		say(`Installing ${dest}…`);
		run("/bin/sh", [script, app, dest, "-"]);
		say("Installed. Log: ~/Library/Logs/pi-crust-update.log");
	}
}

try {
	main();
} catch (e) {
	console.error(`[pi-crust update] ${e.message}`);
	process.exit(1);
}
