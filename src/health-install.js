// Install what is missing (Node, Git, Pi) after a confirm that lists exactly what will be installed and from where, then run
// scripts/install-pi.ps1 (Windows) or scripts/install-pi.sh (macOS) and stream its progress. No UI here: the welcome view calls
// these. Where an install is blocked (no winget, no Homebrew, a managed laptop) the result carries the manual steps instead.
//  - installPlan(needs, platform) -> { ok, steps: [{ id, title, from, command }], lines, text, manual }   (pure: the list for the confirm)
//  - runInstall({ needs, platform, dryRun, ... }) -> Promise<{ ok, code, failedStep, blocked, manual, error, details, lines }>
//  - IPC: health:installPlan({ only? }) -> { needs, plan, token }; health:install({ token, dryRun? }) -> run result plus the fresh health check;
//         health:installCancel stops a running install; progress arrives as "health:install-progress" events (see runInstall's onEvent).
// The confirm is enforced here, not in the window: installPlan returns a one-time token bound to the exact list it returned, and install
// needs that token. It installs exactly that list, and refuses (the window asks again) when a fresh check shows a different one.
// A call without a valid token does nothing. The list is never taken from the window: main asks the health check what is missing.
// The script runs in a neutral folder (the temp folder), with a time limit, and ends with the app (no orphaned winget or npm).
// Selftest (ctx.selftest) always runs the script in dry-run mode: a test never installs anything.
"use strict";

const crypto = require("node:crypto");
const os = require("node:os");
const path = require("node:path");
const { spawn: nodeSpawn } = require("node:child_process");
const { killTree } = require("./kill-tree");
const { PI_PACKAGE } = require("./pi-package");

const PI_SPEC = `${PI_PACKAGE.name}@${PI_PACKAGE.version}`; // pinned: the version this release is tested with
const PI_FROM = `the npm package ${PI_PACKAGE.name} version ${PI_PACKAGE.version} (npmjs.com)`;
const INSTALL_TIMEOUT_MS = 20 * 60_000;

const ORDER = ["node", "git", "pi"];
// Keep `command` in step with the scripts (scripts/install-pi.test.js compares them with the scripts' own dry-run output).
const PLAN = {
	win32: {
		node: { title: "Node.js (current LTS)", from: "the winget package OpenJS.NodeJS.LTS (Windows Package Manager)", command: "winget install --id OpenJS.NodeJS.LTS --exact --silent --accept-package-agreements --accept-source-agreements" },
		git: { title: "Git", from: "the winget package Git.Git (Windows Package Manager)", command: "winget install --id Git.Git --exact --silent --accept-package-agreements --accept-source-agreements" },
		pi: { title: "Pi, the coding agent", from: PI_FROM, command: `npm install -g ${PI_SPEC} --allow-scripts=koffi,protobufjs,@google/genai` },
	},
	darwin: {
		node: { title: "Node.js (current)", from: "the Homebrew formula node", command: "brew install node" },
		git: { title: "Git", from: "the Homebrew formula git", command: "brew install git" },
		pi: { title: "Pi, the coding agent", from: PI_FROM, command: `npm install -g ${PI_SPEC} --allow-scripts=koffi,protobufjs,@google/genai` },
	},
};

// What to do by hand when the install can't run. Plain words, one step each.
function manualSteps(needs, platform) {
	const out = [];
	const win = platform === "win32";
	if (needs.includes("node")) out.push(win ? "Install Node.js (the LTS version) from nodejs.org." : "Install Node.js from nodejs.org, or with Homebrew: brew install node");
	if (needs.includes("git")) out.push(win ? "Install Git from git-scm.com." : "Install Git from git-scm.com, or with Homebrew: brew install git");
	if (needs.includes("pi")) out.push(`Open a new terminal and run: npm install -g ${PI_SPEC}`);
	out.push("Then come back to Pi Crust and choose Check again.");
	return out;
}

const cleanNeeds = (needs) => ORDER.filter((id) => Array.isArray(needs) && needs.includes(id));

// The list for the confirm. `lines` are one bullet each ("Git, from the winget package Git.Git ..."); `text` is the whole dialog text.
function installPlan(needs, platform = process.platform) {
	const ids = cleanNeeds(needs);
	const plan = PLAN[platform];
	if (!ids.length) return { ok: false, steps: [], lines: [], text: "", manual: [], error: "Nothing to install." };
	if (!plan) return { ok: false, steps: [], lines: [], text: "", manual: manualSteps(ids, platform), error: "Pi Crust can't install these on this system." };
	const steps = ids.map((id) => ({ id, ...plan[id] }));
	const lines = steps.map((s) => `${s.title}, from ${s.from}`);
	const text = `Pi Crust will install:\n${lines.map((l) => `• ${l}`).join("\n")}\n\n${platform === "win32" ? "Windows may ask you to confirm. " : ""}Nothing else on this computer is changed.`;
	return { ok: true, steps, lines, text, manual: manualSteps(ids, platform) };
}

function scriptCommand(ids, platform, dryRun, root) {
	if (platform === "win32") return { cmd: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(root, "scripts", "install-pi.ps1"), "-Needs", ids.join(","), ...(dryRun ? ["-DryRun"] : [])] };
	return { cmd: "bash", args: [path.join(root, "scripts", "install-pi.sh"), "--needs", ids.join(","), ...(dryRun ? ["--dry-run"] : [])] };
}

// One output line of the script -> { kind: "step" | "done" | "fail" | "would" | "result" | "text", id?, text }
function parseLine(line) {
	let m = /^STEP (\w+): (.*)$/.exec(line);
	if (m) return { kind: "step", id: m[1], text: m[2] };
	if ((m = /^DONE (\w+)$/.exec(line))) return { kind: "done", id: m[1], text: "" };
	if ((m = /^FAIL (\w+): (.*)$/.exec(line))) return { kind: "fail", id: m[1], text: m[2] };
	if ((m = /^WOULD (\w+): (.*)$/.exec(line))) return { kind: "would", id: m[1], text: m[2] };
	if ((m = /^RESULT (ok|dry-run)\b/.exec(line))) return { kind: "result", text: m[1] };
	return { kind: "text", text: line };
}

// Run the script. deps: { spawn, root, env, onEvent } are replaceable for tests. Never rejects.
// onEvent gets { kind: "start", steps: [id] } first, then { kind, id, text } per parsed line, then { kind: "end", ok }.
// ok is true only when the script exits 0 AND printed its closing "RESULT" line: a script that exits 0 and says nothing failed.
// cwd: the temp folder, never a project folder (a git.exe or npm.cmd lying in a project must not be found). timeoutMs and `signal` (an
// AbortSignal) stop the script and everything it started; the result then has `cancelled` or `timedOut`. onProc(proc) hands out the child.
function runInstall({ needs, platform = process.platform, dryRun = false, spawn = nodeSpawn, root = path.join(__dirname, ".."), env = process.env, onEvent = () => {}, cwd = os.tmpdir(), timeoutMs = INSTALL_TIMEOUT_MS, signal, kill = killTree, onProc = () => {} } = {}) {
	const ids = cleanNeeds(needs);
	const emit = (e) => {
		try {
			onEvent(e);
		} catch {}
	};
	const fail = (error, extra = {}) => {
		emit({ kind: "end", ok: false });
		return { ok: false, code: null, failedStep: null, blocked: false, manual: manualSteps(ids, platform), error, details: "", lines: [], ...extra };
	};
	if (!ids.length) return Promise.resolve({ ok: false, code: null, failedStep: null, blocked: false, manual: [], error: "Nothing to install.", details: "", lines: [] });
	const plan = installPlan(ids, platform);
	if (!plan.ok) return Promise.resolve(fail(plan.error));
	emit({ kind: "start", steps: ids, dryRun: !!dryRun });
	const { cmd, args } = scriptCommand(ids, platform, dryRun, root);
	return new Promise((resolve) => {
		const lines = [];
		let proc;
		let rest = "";
		let sawResult = false;
		let failed = null;
		let current = null;
		const onLine = (raw) => {
			const line = raw.replace(/\r$/, "");
			if (!line.trim()) return;
			lines.push(line);
			const p = parseLine(line);
			if (p.kind === "step") current = p.id;
			if (p.kind === "fail") failed = { id: p.id, why: p.text };
			if (p.kind === "result") sawResult = true;
			emit({ ...p, id: p.id || current });
		};
		try {
			proc = spawn(cmd, args, { cwd, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], detached: platform !== "win32" });
		} catch (e) {
			return resolve(fail(`Couldn't start the installer: ${e.message}`));
		}
		try {
			onProc(proc);
		} catch {}
		const feed = (chunk) => {
			rest += chunk;
			const parts = rest.split("\n");
			rest = parts.pop();
			parts.forEach(onLine);
		};
		proc.stdout?.setEncoding?.("utf8");
		proc.stdout?.on("data", feed);
		proc.stderr?.setEncoding?.("utf8");
		proc.stderr?.on("data", feed);
		let settled = false;
		let stopped = null; // "cancelled" | "timedOut"
		let timer = null;
		let grace = null;
		const onAbort = () => stop("cancelled");
		const settle = (r) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			clearTimeout(grace);
			signal?.removeEventListener?.("abort", onAbort);
			emit({ kind: "end", ok: r.ok });
			resolve(r);
		};
		// End the script and everything it started. If the close event never comes, give up waiting after a few seconds.
		function stop(why) {
			if (settled || stopped) return;
			stopped = why;
			try {
				kill(proc, true);
			} catch {}
			grace = setTimeout(() => finish(null), 5000);
		}
		timer = setTimeout(() => stop("timedOut"), timeoutMs);
		if (signal) signal.aborted ? stop("cancelled") : signal.addEventListener("abort", onAbort, { once: true });
		proc.on("error", (e) => settle({ ok: false, code: null, failedStep: null, blocked: false, manual: manualSteps(ids, platform), error: `Couldn't start the installer: ${e.message}`, details: lines.join("\n"), lines }));
		proc.on("close", (code) => finish(code));
		function finish(code) {
			if (rest.trim()) onLine(rest);
			rest = "";
			const details = lines.slice(-40).join("\n");
			if (stopped === "cancelled") return settle({ ok: false, code, failedStep: current, blocked: false, cancelled: true, manual: [], error: "The install was cancelled.", details, lines });
			if (stopped === "timedOut") return settle({ ok: false, code, failedStep: current, blocked: false, timedOut: true, manual: manualSteps(ids, platform), error: `The install took longer than ${Math.round(timeoutMs / 60000)} minutes and was stopped.`, details, lines });
			if (code === 0 && sawResult) return settle({ ok: true, code, failedStep: null, blocked: false, manual: [], error: "", details, lines, dryRun: !!dryRun });
			const blocked = code === 3;
			const title = failed && plan.steps.find((s) => s.id === failed.id)?.title;
			let error;
			if (blocked) error = failed ? failed.why : "The installer can't run on this computer.";
			else if (failed) error = `Installing ${title || failed.id} didn't work: ${failed.why}.`;
			else if (code === 0) error = "The installer stopped without saying it finished.";
			else if (code === 2) error = "The installer didn't understand what to install.";
			else error = `The installer stopped (exit code ${code}).`;
			settle({ ok: false, code, failedStep: failed ? failed.id : current, blocked, manual: manualSteps(ids, platform), error, details, lines });
		}
	});
}

// The IPC handlers, with their dependencies replaceable for tests: createHandlers(ctx, { run, newToken, kill }) -> { plan, install, cancel, stopNow }
function createHandlers(ctx, { run = runInstall, newToken = () => crypto.randomBytes(16).toString("hex"), kill = killTree } = {}) {
	let pending = null; // { token, needs, only }: the one list a confirm was shown for
	let running = false;
	let controller = null;
	let child = null;
	// What is missing right now, from the health check (never from the window), narrowed by `only` when given.
	async function needsNow(only) {
		const h = await ctx.health.check({ fresh: true }); // look again now: a tool installed meanwhile must not be listed
		return Array.isArray(only) ? h.needs.filter((id) => only.includes(id)) : h.needs;
	}
	const refuse = (error, extra = {}) => ({ ok: false, error, manual: [], details: "", lines: [], ...extra });
	return {
		// The list for the confirm, and the token that lets exactly this list be installed once.
		async plan(_e, o) {
			const only = Array.isArray(o?.only) ? o.only.filter((x) => typeof x === "string") : undefined;
			const needs = await needsNow(only);
			const plan = installPlan(needs);
			pending = plan.ok ? { token: newToken(), needs: [...needs], only } : null;
			return { needs, plan, token: pending ? pending.token : null };
		},
		async install(_e, o = {}) {
			// Everything up to `running = true` is synchronous: two calls in the same tick can't both get past it.
			if (running) return refuse("An install is already running.");
			const p = pending;
			if (!p || !o || typeof o.token !== "string" || o.token !== p.token) return refuse("Nothing was confirmed. Look at the list again.", { noToken: true });
			pending = null; // one time only
			running = true;
			controller = new AbortController();
			try {
				const needs = await needsNow(p.only);
				if (needs.join() !== p.needs.join()) return refuse("What is missing has changed since the list was shown. Look at the list again.", { changed: true, needs });
				const r = await run({ needs: p.needs, dryRun: o.dryRun === true || ctx.selftest === true, env: ctx.env, signal: controller.signal, onProc: (c) => (child = c), onEvent: (e) => ctx.send("health:install-progress", e) });
				// A real install changes what is on the machine: look again, no restart (Pi location, PATH for Pi, sign-in answer).
				if (r.ok && !r.dryRun) {
					ctx.refreshPi?.();
					ctx.subsStatus?.invalidate();
				}
				return { ...r, health: await ctx.health.check({ fresh: true }) };
			} finally {
				running = false;
				controller = null;
				child = null;
			}
		},
		cancel() {
			if (!controller) return { ok: false };
			controller.abort();
			return { ok: true };
		},
		isRunning: () => running,
		// The app is quitting: end the script and its children now (synchronously), so nothing is left running.
		stopNow() {
			if (!running) return false;
			try {
				controller?.abort();
			} catch {}
			try {
				if (child) kill(child, true, { sync: true });
			} catch {}
			return true;
		},
	};
}

function register(ctx) {
	const { ipcMain } = ctx;
	const h = createHandlers(ctx);
	ipcMain.handle("health:installPlan", h.plan);
	ipcMain.handle("health:install", h.install);
	ipcMain.handle("health:installCancel", h.cancel);
	// Quitting mid-install stops the script cleanly instead of leaving winget or npm running without an app.
	ctx.app?.on?.("before-quit", h.stopNow);
	process.on("exit", h.stopNow);
	return h;
}

module.exports = { register, createHandlers, installPlan, manualSteps, runInstall, parseLine, scriptCommand, PLAN, ORDER, PI_SPEC, INSTALL_TIMEOUT_MS };
