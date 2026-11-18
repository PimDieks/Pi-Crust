// Setup health, main process: finds out what is installed and set up (Pi, Node, Git, sign-in, project, Figma) and hands the
// facts to health-logic.js, which turns them into rows with words. Read-only: nothing is installed or changed here.
//  - health:check({ figma?, devServer? })    -> { rows, required, ready, counts, needs, facts }
//  - health:recheck({ figma?, devServer? })  -> the same, after forgetting the remembered Pi location and sign-in answer
//                                               (use it after an install or a sign-in: no app restart needed)
//  - health:onboarding / health:onboardingSet(key)   -> { doneAt, skippedAt, firstTaskDoneAt } in settings.json
// Never probes by itself: the welcome view asks. Figma is only asked when `figma: true` (phase 4: never at startup).
// Sign-in comes from subscriptions-main's status (Pi's own `pi auth check`); auth files and tokens are never read here.
// Selftest only (ctx.selftest, never true in a packaged app): PI_CRUST_HEALTH_STUB=<json> makes the detectors answer from
// the stub (see stubFacts in health-logic.js), health:stubSet(json) changes it, and onboarding state stays in memory.
"use strict";

const { execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const L = require("./health-logic");

// Run a program, never throw. { ok, code (exit code), errCode ("ENOENT", ...), stdout, stderr }.
function defaultExec(cmd, args, opts = {}) {
	return new Promise((resolve) => {
		execFile(cmd, args, { windowsHide: true, maxBuffer: 1e6, timeout: 15_000, ...opts }, (err, stdout, stderr) => {
			resolve({ ok: !err, code: err ? (typeof err.code === "number" ? err.code : null) : 0, errCode: err && typeof err.code === "string" ? err.code : null, stdout: String(stdout || ""), stderr: String(stderr || "") });
		});
	});
}

// Where an installer puts things, which the app's own PATH (read when the app started) may not know about yet.
function usualDirs(platform, env, home) {
	if (platform === "win32") {
		const local = env.LOCALAPPDATA || path.join(home, "AppData", "Local");
		const pf = env.ProgramFiles || "C:\\Program Files";
		return { node: [path.join(pf, "nodejs"), path.join(local, "Programs", "nodejs")], git: [path.join(pf, "Git", "cmd"), path.join(local, "Programs", "Git", "cmd")] };
	}
	const common = ["/opt/homebrew/bin", "/usr/local/bin"];
	return { node: common, git: common };
}
// The first real file called `name` (or name.exe / .cmd / .bat on Windows) in the PATH folders of `env`: an absolute path, or null.
// Never looks in the current folder, so a git.exe sitting in a project folder is not found by accident.
function which(name, env, platform, fsx, delimiter) {
	const exts = platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
	for (const dir of String(env[pathKey(env)] || "").split(delimiter)) {
		const d = dir.replace(/^"|"$/g, "");
		if (!d || !path.isAbsolute(d)) continue;
		for (const ext of exts) {
			const p = path.join(d, name + ext);
			try {
				if (fsx.existsSync(p) && fsx.statSync(p).isFile()) return p;
			} catch {}
		}
	}
	return null;
}
const pathKey = (env) => Object.keys(env).find((k) => k.toUpperCase() === "PATH") || "PATH";
function withDirs(env, dirs, fsx, delimiter) {
	const have = dirs.filter((d) => {
		try {
			return fsx.existsSync(d);
		} catch {
			return false;
		}
	});
	const k = pathKey(env);
	return have.length ? { ...env, [k]: [...have, env[k] || ""].join(delimiter) } : env;
}

// d: { exec, fs, env: () => env, platform, home, delimiter, findPi({ fresh }), subsStatus, figmaStatus, getRepo, devUrl, fetch, stub: () => facts | null }
// Every dependency can be replaced, so the tests run each detector against a failing, a passing and a garbage answer.
function createHealth(d) {
	const exec = d.exec || defaultExec;
	const fsx = d.fs || fs;
	const platform = d.platform || process.platform;
	const home = d.home || os.homedir();
	const delimiter = d.delimiter || path.delimiter;
	const env = () => d.env?.() || process.env;
	const dirs = usualDirs(platform, env(), home);
	const first = (text) => String(text || "").split(/\r?\n/).find((l) => l.trim()) || "";

	async function detectPi(fresh) {
		const pi = d.findPi({ fresh });
		if (!pi) return { state: "missing", version: null };
		const r = await exec(pi.command, [...pi.args, "--version"], { env: env(), cwd: home, timeout: 15_000 });
		if (r.errCode === "ENOENT") return { state: "missing", version: null };
		const version = L.parseVersion(first(r.stdout)) || L.parseVersion(first(r.stderr));
		return version ? { state: "ok", version } : { state: "unknown", version: null };
	}

	async function detectNode() {
		const e = withDirs(env(), dirs.node, fsx, delimiter);
		const r = await exec("node", ["--version"], { env: e, cwd: home, timeout: 10_000 });
		if (r.errCode === "ENOENT") return { state: "missing", version: null };
		const version = L.parseVersion(first(r.stdout));
		return r.ok && version ? { state: "ok", version } : { state: "unknown", version: null };
	}

	async function detectGit() {
		const e = withDirs(env(), dirs.git, fsx, delimiter);
		// macOS: /usr/bin/git is a stub that opens an "install developer tools" window when there is no real Git. Don't run it then.
		if (platform === "darwin" && !dirs.git.some((dir) => fsx.existsSync(path.join(dir, "git")))) {
			const t = await exec("xcode-select", ["-p"], { env: e, timeout: 5_000 });
			if (!t.ok) return { state: "missing", version: null };
		}
		const r = await exec("git", ["--version"], { env: e, cwd: home, timeout: 10_000 });
		if (r.errCode === "ENOENT") return { state: "missing", version: null };
		const version = L.parseVersion(first(r.stdout));
		// `path`: the Git that answered, as an absolute path (init-git-main runs exactly this one, never a bare "git").
		return r.ok && version ? { state: "ok", version, path: which("git", e, platform, fsx, delimiter) } : { state: "unknown", version: null };
	}

	// The folder exists, and is a Git project: it, or a folder above it, has a `.git` (a folder, or a file in a linked worktree).
	function detectProject() {
		const repo = d.getRepo();
		if (!repo) return { repo: null, exists: false, isGit: null };
		try {
			if (!fsx.statSync(repo).isDirectory()) return { repo, exists: false, isGit: null };
		} catch {
			return { repo, exists: false, isGit: null };
		}
		for (let dir = path.resolve(repo), prev = null; dir !== prev; prev = dir, dir = path.dirname(dir)) {
			try {
				if (fsx.existsSync(path.join(dir, ".git"))) return { repo, exists: true, isGit: true };
			} catch {}
		}
		return { repo, exists: true, isGit: false };
	}

	async function detectDevServer() {
		const url = d.devUrl;
		try {
			await (d.fetch || fetch)(url, { signal: AbortSignal.timeout(1500) }); // any answer at all means something listens
			return { url, up: true };
		} catch {
			return { url, up: false };
		}
	}

	// onRow(row) gets each row of the view as soon as its facts are in (Pi and Git first, then the rows that need them), so the view
	// fills in while the slow ones (the sign-in check, Figma) are still running.
	async function facts({ figma = false, devServer = false, fresh = false } = {}, onRow = () => {}) {
		const stub = d.stub?.();
		if (stub) return stub;
		const emit = (row) => {
			try {
				onRow(row);
			} catch {}
		};
		const piP = detectPi(fresh).then((pi) => (emit(L.piRow(pi)), pi));
		const nodeP = detectNode();
		const gitP = detectGit().then((git) => (emit(L.gitRow(git)), git));
		const projectP = gitP.then((git) => {
			const project = detectProject();
			emit(L.projectRow(project, git, home));
			return project;
		});
		// No Pi, nothing to ask: `pi auth check` would only fail the same way.
		const subsP = piP.then(async (pi) => {
			let subs = null;
			if (pi.state !== "missing" && d.subsStatus) {
				try {
					subs = await d.subsStatus();
				} catch {}
			}
			emit(L.authRow({ subs }, pi));
			return subs;
		});
		const figmaP = (async () => {
			let fg = null;
			if (figma && d.figmaStatus) {
				try {
					fg = await d.figmaStatus();
				} catch {
					fg = { state: "problem", message: "" };
				}
			}
			emit(L.figmaRow(fg));
			return fg;
		})();
		const [pi, node, git, project, subs, fg] = await Promise.all([piP, nodeP, gitP, projectP, subsP, figmaP]);
		const out = { pi, node, git, auth: { subs }, project, figma: fg };
		if (devServer) out.devServer = await detectDevServer();
		return out;
	}

	// Two checks at once share one run (a run that asks for at least as much as the newcomer). A newcomer is given the rows that
	// already came in. Not with a stub (selftest): there every answer must reflect the stub as it is right now.
	const runs = [];
	function check(o = {}, onRow = () => {}) {
		const want = { figma: !!o.figma, devServer: !!o.devServer, fresh: !!o.fresh };
		let run = d.stub?.() ? null : runs.find((r) => (r.o.figma || !want.figma) && (r.o.devServer || !want.devServer) && (r.o.fresh || !want.fresh));
		if (run) {
			run.rows.forEach(onRow);
			run.listeners.add(onRow);
			return run.promise;
		}
		run = { o: want, rows: [], listeners: new Set([onRow]) };
		runs.push(run);
		run.promise = (async () => {
			try {
				const f = await facts(want, (row) => {
					run.rows.push(row);
					run.listeners.forEach((l) => {
						try {
							l(row);
						} catch {}
					});
				});
				const h = L.buildHealth(f, { home });
				try {
					d.onResult?.(h);
				} catch {}
				return h;
			} finally {
				runs.splice(runs.indexOf(run), 1);
			}
		})();
		return run.promise;
	}

	return { detectPi, detectNode, detectGit, detectProject, detectDevServer, facts, check, runsInFlight: () => runs.length };
}

// lastReadyAt: set by main whenever a check finds every required row ready, cleared when one finds otherwise. Startup reads it to
// decide whether it has to look at all (setup done and the last check was ready: it does not).
const ONBOARDING_KEYS = ["doneAt", "skippedAt", "firstTaskDoneAt", "firstTaskHiddenAt", "lastReadyAt"];

function register(ctx) {
	const { ipcMain } = ctx;
	// Selftest only. The stub is switched on by the variable and changed with health:stubSet; without it nothing here is stubbed.
	let stub = null;
	let stubOn = false;
	if (ctx.selftest === true && process.env.PI_CRUST_HEALTH_STUB !== undefined) {
		stubOn = true;
		try {
			stub = L.stubFacts(JSON.parse(process.env.PI_CRUST_HEALTH_STUB || "{}"));
		} catch {
			stub = L.stubFacts({});
		}
	}
	let mem = {}; // onboarding state in memory while stubbed: the real settings.json stays untouched
	const read = () => (stubOn ? mem : ctx.readSettings().onboarding) || {};
	const setKey = (key, on) => {
		const next = { ...read(), [key]: on ? Date.now() : undefined };
		if (!on) delete next[key];
		if (stubOn) mem = next;
		else ctx.writeSettings({ onboarding: next });
		return next;
	};
	// Every finished check records whether everything required was ready (only when it changes). A selftest without the stub
	// never touches the real settings.
	const trackReady = (h) => {
		if (ctx.selftest === true && !stubOn) return;
		if (!!read().lastReadyAt !== !!h.ready) setKey("lastReadyAt", !!h.ready);
	};
	const health = createHealth({
		onResult: trackReady,
		findPi: (o) => ctx.findPi(o),
		env: () => ctx.env,
		subsStatus: () => ctx.subsStatus?.status(),
		figmaStatus: () => ctx.figmaStatus?.(),
		getRepo: () => ctx.repo,
		devUrl: ctx.devUrl,
		stub: () => stub,
	});
	// After an install the remembered Pi location, the app's PATH for Pi and the cached sign-in answer are all out of date.
	const refresh = () => {
		ctx.refreshPi?.();
		ctx.subsStatus?.invalidate();
	};
	// Rows reach the window as they come in ("health:row"), then the whole result is the answer.
	const rowOut = (row) => ctx.send?.("health:row", row);
	ipcMain.handle("health:check", (_e, o) => health.check(o || {}, rowOut));
	ipcMain.handle("health:recheck", (_e, o) => {
		refresh();
		return health.check({ ...(o || {}), fresh: true }, rowOut);
	});
	ipcMain.handle("health:onboarding", () => ({ ...read() }));
	// key: "doneAt" | "skippedAt" | "firstTaskDoneAt"; sets it to now, or clears it with value === null.
	ipcMain.handle("health:onboardingSet", (_e, key, value) => {
		if (!ONBOARDING_KEYS.includes(key)) return { ok: false, error: "Unknown key" };
		return { ok: true, onboarding: setKey(key, value !== null) };
	});
	if (stubOn) {
		ipcMain.handle("health:stubSet", (_e, s) => {
			stub = L.stubFacts(s || {});
			return true;
		});
	}
	ctx.health = health; // for health-install.js: what is missing comes from here, never from the window
	return health;
}

module.exports = { register, createHealth, defaultExec, usualDirs, withDirs, ONBOARDING_KEYS };
