// Pi Crust updating itself: checks its own git clone for new commits upstream and, on request, runs
// scripts/update.js there. The UI is the update card in the notifications above the chat (app-update.js).
// - Running from the clone (npm start, or a macOS .app that links to it): pull; restarting starts the new code.
// - The installed app (Windows, or a macOS Pi Crust.app): it knows its clone and build commit from package.json
//   (piCrustSource, piCrustCommit, stamped by scripts/dist-win.js / dist-mac.js). Pull and build (the Windows
//   installer, or a new Pi Crust.app); on Restart now (or when the app quits) that replaces this app once it has
//   exited: the installer on Windows, scripts/mac-install-app.sh on macOS.
// Nothing quits by itself: once prepared, the state is "ready" and the user picks Restart now or Later.
const { execFile, spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const CHECK_EVERY_MS = 60 * 60 * 1000;
const FIRST_CHECK_MS = 15 * 1000;
const IS_WIN = process.platform === "win32";
const IS_MAC = process.platform === "darwin";

// A Pi Crust git clone: has .git and a package.json named pi-crust.
function isClone(dir) {
	try {
		return !!dir && fs.existsSync(path.join(dir, ".git")) && JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).name === "pi-crust";
	} catch {
		return false;
	}
}

// Where to update from: { dir, installed, commit } or null.
function findSource(app) {
	let meta = {};
	try {
		meta = JSON.parse(fs.readFileSync(path.join(app.getAppPath(), "package.json"), "utf8"));
	} catch {}
	let dir;
	try {
		dir = fs.realpathSync(app.getAppPath());
	} catch {
		dir = app.getAppPath();
	}
	for (let i = 0; i < 3 && dir; i++, dir = path.dirname(dir)) if (isClone(dir)) return { dir, installed: false, commit: null };
	if (!app.isPackaged || !(IS_WIN || IS_MAC)) return null; // builds for other platforms can't be redone from here
	if (isClone(meta.piCrustSource)) return { dir: meta.piCrustSource, installed: true, commit: meta.piCrustCommit || null };
	// Installed before builds were stamped: the clone is probably where SETUP.md puts it.
	for (const d of ["Pi-Crust", "pi-crust"].map((n) => path.join(os.homedir(), "Documents", n))) if (isClone(d)) return { dir: d, installed: true, commit: null };
	return null;
}

function register(ctx) {
	const { app, ipcMain } = ctx;
	const source = findSource(app);
	// state: "none" (nothing to show) | "available" | "updating" | "error"
	let status = { state: "none" };
	let busy = false;
	let installer = null; // the built installer (Windows) or Pi Crust.app (macOS), waiting for Restart now or quit
	// macOS: this app's bundle (…/Pi Crust.app/Contents/MacOS/Pi Crust -> …/Pi Crust.app).
	const bundle = IS_MAC ? path.resolve(path.dirname(process.execPath), "..", "..") : null;
	const set = (s) => {
		status = s;
		ctx.send("appUpdate:status", status);
	};

	const git = (args, timeout = 60e3) =>
		new Promise((resolve, reject) =>
			execFile("git", args, { cwd: source.dir, env: { ...ctx.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" }, timeout, windowsHide: true, maxBuffer: 10e6 }, (err, out, errOut) =>
				err ? reject(new Error(String(errOut || err.message).trim())) : resolve(String(out).trim()),
			),
		);

	async function check() {
		if (!source || busy || status.state === "ready" || status.state === "restarting") return status;
		try {
			await git(["fetch", "--quiet"], 120e3);
			await git(["rev-parse", "--abbrev-ref", "@{u}"]); // no upstream: nothing to update from
			// The installed app may be older than its clone (pulled, never rebuilt): compare with the commit it was built from.
			let base = "HEAD";
			if (source.commit) base = await git(["cat-file", "-e", `${source.commit}^{commit}`]).then(() => source.commit, () => "HEAD");
			const commits = (await git(["log", "--format=%h %s", `${base}..@{u}`])).split(/\r?\n/).filter(Boolean);
			if (!commits.length) {
				if (status.state !== "error") set({ state: "none" });
				return status;
			}
			// Pulling needs a clean, fast-forwardable clone (scripts/update.js refuses otherwise): say so up front.
			let blocked = null;
			let blockedDetail = null;
			if (Number(await git(["rev-list", "--count", "HEAD..@{u}"]))) {
				if (await git(["status", "--porcelain", "--untracked-files=no"])) {
					blocked = "Uncommitted changes in its folder";
					blockedDetail = `Pi Crust's folder (${source.dir}) has uncommitted changes. Commit or stash them, then update.`;
				} else if (Number(await git(["rev-list", "--count", "@{u}..HEAD"]))) {
					blocked = "Unpushed commits in its folder";
					blockedDetail = `Pi Crust's folder (${source.dir}) has local commits that aren't pushed. Push or rebase them, then update.`;
				}
			}
			set({ state: "available", count: commits.length, commits: commits.slice(0, 30), blocked, blockedDetail });
		} catch (e) {
			console.error("update check failed:", e.message); // offline, no remote, ...: keep quiet in the UI
		}
		return status;
	}

	function update() {
		if (!source || busy) return;
		if (IS_MAC && source.installed) {
			try {
				fs.accessSync(path.dirname(bundle), fs.constants.W_OK);
			} catch {
				return set({ state: "error", message: `Pi Crust can't replace itself in ${path.dirname(bundle)} (no write access). Run npm run update -- --app in ${source.dir}, or move Pi Crust to ~/Applications.` });
			}
		}
		busy = true;
		set({ state: "updating", step: "Starting…" });
		const args = [path.join(source.dir, "scripts", "update.js"), ...(source.installed ? ["--app", "--no-run"] : ["--no-app"])];
		// Our own Electron as Node, so no Node on PATH is needed for the script itself (npm still is).
		const child = spawn(process.execPath, args, { cwd: source.dir, env: { ...ctx.env, ELECTRON_RUN_AS_NODE: "1" }, windowsHide: true });
		let out = "";
		const onData = (d) => {
			out += d;
			const steps = String(out).match(/\[pi-crust update\] [^\r\n]+/g);
			if (steps) set({ state: "updating", step: steps[steps.length - 1].replace("[pi-crust update] ", "") });
		};
		child.stdout.on("data", onData);
		child.stderr.on("data", onData);
		child.on("error", (e) => {
			busy = false;
			set({ state: "error", message: e.message });
		});
		child.on("close", (code) => {
			busy = false;
			if (code !== 0) {
				// The script's last "[pi-crust update] ..." line is the error. When it only says a command failed, add the
				// last lines that command printed (electron-builder's "  • ..." progress lines left out).
				const MARK = "[pi-crust update] ";
				const at = out.lastIndexOf(MARK);
				const before = (at < 0 ? out : out.slice(0, at)).split(/\r?\n/).filter((l) => l.trim() && !l.includes(MARK) && !/^\s*[•[]/.test(l));
				let err = at < 0 ? before.slice(-6).join("\n") : out.slice(at + MARK.length).trim();
				if (at >= 0 && / failed$/.test(err) && before.length) err += `:\n${before.slice(-3).join("\n")}`;
				return set({ state: "error", message: err || `The update stopped (exit code ${code}).` });
			}
			// Ready: nothing is closed until the user says so (Restart now), or quits (the installed app installs then).
			if (source.installed) {
				installer = out.match(IS_MAC ? /^APP=(.+)$/m : /^INSTALLER=(.+)$/m)?.[1]?.trim() || null;
				if (!installer || !fs.existsSync(installer)) return set({ state: "error", message: IS_MAC ? "Pi Crust.app was not built." : "The installer was not built." });
			}
			set({ state: "ready", installed: source.installed });
		});
	}

	// The installed app: the installer replaces it once it has exited (--updated waits for that).
	// --force-run starts the new version afterwards.
	function runInstaller(start) {
		if (!installer || !fs.existsSync(installer)) return false;
		if (IS_MAC) {
			// Swaps the bundle once this process is gone (never under a running app), then opens it for a restart.
			const script = path.join(source.dir, "scripts", "mac-install-app.sh");
			spawn("/bin/sh", [script, installer, bundle, String(process.pid), start ? "open" : ""], { detached: true, stdio: "ignore" }).unref();
		} else spawn(installer, ["/S", "--updated", ...(start ? ["--force-run"] : [])], { detached: true, stdio: "ignore" }).unref();
		installer = null;
		return true;
	}

	function restart() {
		if (status.state !== "ready") return;
		set({ state: "restarting" });
		if (source.installed) runInstaller(true);
		else app.relaunch();
		app.quit(); // the usual quit: chats are stopped and reopen after the restart
	}
	// "Later": a prepared update of the installed app is installed when Pi Crust quits (without starting it again).
	app.on("will-quit", () => {
		if (status.state === "ready") runInstaller(false);
	});

	ipcMain.handle("appUpdate:status", () => status);
	ipcMain.handle("appUpdate:check", () => check());
	ipcMain.handle("appUpdate:run", () => update());
	ipcMain.handle("appUpdate:restart", () => restart());
	if (!source || ctx.selftest) return;
	setTimeout(check, FIRST_CHECK_MS);
	setInterval(check, CHECK_EVERY_MS).unref?.();
}

module.exports = { register, isClone, findSource };
