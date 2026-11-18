// Install what is missing (Node, Git, Pi) after a confirm that lists exactly what will be installed and from where, then run
// scripts/install-pi.ps1 (Windows) or scripts/install-pi.sh (macOS) and stream its progress. No UI here: the welcome view calls
// these. Where an install is blocked (no winget, no Homebrew, a managed laptop) the result carries the manual steps instead.
//  - installPlan(needs, platform) -> { ok, steps: [{ id, title, from, command }], lines, text, manual }   (pure: the list for the confirm)
//  - runInstall({ needs, platform, dryRun, ... }) -> Promise<{ ok, code, failedStep, blocked, manual, error, details, lines }>
//  - IPC: health:installPlan({ only? }) -> { needs, plan }; health:install({ only?, dryRun? }) -> run result plus the fresh health check;
//         progress arrives as "health:install-progress" events (see runInstall's onEvent).
// The list of what to install is never taken from the window: main asks the health check what is missing (`only` can only narrow it).
// Selftest (ctx.selftest) always runs the script in dry-run mode: a test never installs anything.
"use strict";

const path = require("node:path");
const { spawn: nodeSpawn } = require("node:child_process");

const ORDER = ["node", "git", "pi"];
// Keep `command` in step with the scripts (scripts/install-pi.test.js compares them with the scripts' own dry-run output).
const PLAN = {
	win32: {
		node: { title: "Node.js (current LTS)", from: "the winget package OpenJS.NodeJS.LTS (Windows Package Manager)", command: "winget install --id OpenJS.NodeJS.LTS --exact --silent --accept-package-agreements --accept-source-agreements" },
		git: { title: "Git", from: "the winget package Git.Git (Windows Package Manager)", command: "winget install --id Git.Git --exact --silent --accept-package-agreements --accept-source-agreements" },
		pi: { title: "Pi, the coding agent", from: "the npm package @earendil-works/pi-coding-agent (npmjs.com)", command: "npm install -g @earendil-works/pi-coding-agent --allow-scripts=koffi,protobufjs,@google/genai" },
	},
	darwin: {
		node: { title: "Node.js (current)", from: "the Homebrew formula node", command: "brew install node" },
		git: { title: "Git", from: "the Homebrew formula git", command: "brew install git" },
		pi: { title: "Pi, the coding agent", from: "the npm package @earendil-works/pi-coding-agent (npmjs.com)", command: "npm install -g @earendil-works/pi-coding-agent --allow-scripts=koffi,protobufjs,@google/genai" },
	},
};

// What to do by hand when the install can't run. Plain words, one step each.
function manualSteps(needs, platform) {
	const out = [];
	const win = platform === "win32";
	if (needs.includes("node")) out.push(win ? "Install Node.js (the LTS version) from nodejs.org." : "Install Node.js from nodejs.org, or with Homebrew: brew install node");
	if (needs.includes("git")) out.push(win ? "Install Git from git-scm.com." : "Install Git from git-scm.com, or with Homebrew: brew install git");
	if (needs.includes("pi")) out.push("Open a new terminal and run: npm install -g @earendil-works/pi-coding-agent");
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
function runInstall({ needs, platform = process.platform, dryRun = false, spawn = nodeSpawn, root = path.join(__dirname, ".."), env = process.env, onEvent = () => {} } = {}) {
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
			proc = spawn(cmd, args, { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
		} catch (e) {
			return resolve(fail(`Couldn't start the installer: ${e.message}`));
		}
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
		const settle = (r) => {
			if (settled) return;
			settled = true;
			emit({ kind: "end", ok: r.ok });
			resolve(r);
		};
		proc.on("error", (e) => settle({ ok: false, code: null, failedStep: null, blocked: false, manual: manualSteps(ids, platform), error: `Couldn't start the installer: ${e.message}`, details: lines.join("\n"), lines }));
		proc.on("close", (code) => {
			if (rest.trim()) onLine(rest);
			rest = "";
			const details = lines.slice(-40).join("\n");
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
		});
	});
}

function register(ctx) {
	const { ipcMain } = ctx;
	let running = false;
	// What is missing right now, from the health check (never from the window), narrowed by `only` when given.
	async function needsNow(only) {
		const h = await ctx.health.check({ fresh: true }); // look again now: a tool installed meanwhile must not be listed
		return Array.isArray(only) ? h.needs.filter((id) => only.includes(id)) : h.needs;
	}
	ipcMain.handle("health:installPlan", async (_e, o) => {
		const needs = await needsNow(o && o.only);
		return { needs, plan: installPlan(needs) };
	});
	ipcMain.handle("health:install", async (_e, o = {}) => {
		if (running) return { ok: false, error: "An install is already running.", manual: [], details: "", lines: [] };
		const needs = await needsNow(o.only);
		running = true;
		try {
			const r = await runInstall({ needs, dryRun: o.dryRun === true || ctx.selftest === true, env: ctx.env, onEvent: (e) => ctx.send("health:install-progress", e) });
			// A real install changes what is on the machine: look again, no restart (Pi location, PATH for Pi, sign-in answer).
			if (r.ok && !r.dryRun) {
				ctx.refreshPi?.();
				ctx.subsStatus?.invalidate();
			}
			return { ...r, health: await ctx.health.check({ fresh: true }) };
		} finally {
			running = false;
		}
	});
}

module.exports = { register, installPlan, manualSteps, runInstall, parseLine, scriptCommand, PLAN, ORDER };
