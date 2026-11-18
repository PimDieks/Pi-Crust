// Setup health: pure logic. Raw facts (what the detectors in health-main.js found) -> rows with a state, one plain line and
// one action. No I/O here, so every state and every word can be tested without a window.
//
// A row: { id, label, state, line, action, optional }
//   state:  "ready" (green tick) | "todo" (empty circle) | "unknown" (grey dash, "Can't tell")
//   action: { id, label } or null. One action per row; ids: install-pi, update-pi, install-git, sign-in, choose-folder,
//           init-git, setup-figma, recheck.
// Result: { rows, required, ready, counts: { done, total }, needs, facts }
//   needs:  what an install would have to add, in install order: a subset of ["node", "git", "pi"] (see install-pi script).
"use strict";

// Assumed floors (Pim's open decision 6): Pi from the version that has `pi auth check`, Node as npm lists it for Pi 1.5.x.
const MIN_PI = "1.0.0";
const MIN_NODE = "22.19.0";

const REQUIRED = ["pi", "auth", "git", "project"];
const LABELS = { pi: "Pi", auth: "Model provider", git: "Git", project: "Project", figma: "Figma" };

// "git version 2.47.1.windows.1" / "v22.19.0" / "1.4.0" -> "2.47.1" / "22.19.0" / "1.4.0", or null.
function parseVersion(text) {
	const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(text || ""));
	return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
}
// -1, 0 or 1; null when either side isn't a version.
function compareVersions(a, b) {
	const x = parseVersion(a);
	const y = parseVersion(b);
	if (!x || !y) return null;
	const p = x.split(".").map(Number);
	const q = y.split(".").map(Number);
	for (let i = 0; i < 3; i++) if (p[i] !== q[i]) return p[i] < q[i] ? -1 : 1;
	return 0;
}
const isOld = (v, min) => compareVersions(v, min) === -1;

// "C:\Users\me\Documents\site" -> "~/Documents/site".
function tidyPath(p, home) {
	let s = String(p || "").replace(/\\/g, "/");
	const h = home ? String(home).replace(/\\/g, "/").replace(/\/+$/, "") : "";
	if (h && (s === h || s.startsWith(`${h}/`))) s = `~${s.slice(h.length)}`;
	return s;
}

const act = (id, label) => ({ id, label });
const row = (id, state, line, action = null, extra = {}) => ({ id, label: LABELS[id], state, line, action, ...extra });

// facts.pi:   { state: "ok" | "missing" | "unknown", version }   (unknown = found, but `pi --version` gave nothing usable)
function piRow(f) {
	if (f.state === "missing") return row("pi", "todo", "Pi isn't installed on this computer. Pi Crust can install it for you.", act("install-pi", "Install Pi"));
	if (f.state === "ok" && isOld(f.version, MIN_PI)) return row("pi", "todo", `This Pi is too old (${f.version}). Install the current one.`, act("update-pi", "Update Pi"));
	if (f.state === "ok" && parseVersion(f.version)) return row("pi", "ready", `Pi ${parseVersion(f.version)} is installed.`);
	return row("pi", "unknown", "Pi is installed, but Pi Crust can't read its version.", act("recheck", "Check again"));
}

// facts.subs: the `subs:status` result ({ rows: [{ id, label, kind, status, detail, authType }] }) or null when that failed.
function authRow(f, piFact) {
	const rows = (f.subs && Array.isArray(f.subs.rows) && f.subs.rows) || null;
	if (piFact.state === "missing") return row("auth", "todo", "Install Pi first, then sign in.");
	if (!rows) return row("auth", "unknown", "Pi Crust can't check sign-in with this version of Pi.", act("recheck", "Check again"));
	const connected = rows.filter((r) => r.status === "connected");
	if (connected.length) {
		// A real sign-in beats a key from the environment, which beats a local model.
		const rank = (r) => (r.authType === "oauth" ? 0 : r.authType === "api_key" ? 1 : r.authType === "env" ? 2 : 3);
		const r = [...connected].sort((a, b) => rank(a) - rank(b))[0];
		if (r.authType === "env") return row("auth", "ready", "Using an API key from your computer's settings.");
		if (r.kind === "local") return row("auth", "ready", "Using a model on this computer (Ollama).");
		return row("auth", "ready", `Signed in to ${r.label}.`);
	}
	// A provider that can be signed in to and says "not signed in" is a definite answer. Only "couldn't check" everywhere is not.
	const definite = rows.some((r) => r.kind !== "local" && r.status === "disconnected");
	if (definite) return row("auth", "todo", "Sign in to a model provider.", act("sign-in", "Sign in"));
	return row("auth", "unknown", "Pi Crust can't check sign-in with this version of Pi.", act("recheck", "Check again"));
}

// facts.git: { state: "ok" | "missing" | "unknown", version }
function gitRow(f) {
	if (f.state === "ok") return row("git", "ready", parseVersion(f.version) ? `Git ${parseVersion(f.version)} is installed.` : "Git is installed.");
	if (f.state === "missing") return row("git", "todo", "Git isn't installed. Pi Crust needs it to show your changes and to undo.", act("install-git", "Install Git"));
	return row("git", "unknown", "Can't tell if Git is installed.", act("recheck", "Check again"));
}

// facts.project: { repo, exists, isGit }   repo null = none chosen; exists false = gone or unreadable; isGit true | false | null (can't tell)
function projectRow(f, gitFact, home) {
	if (!f.repo) return row("project", "todo", "Pick the folder you want to work on.", act("choose-folder", "Choose folder"));
	if (!f.exists) return row("project", "unknown", "Pi Crust can't read that folder.", act("choose-folder", "Choose folder"));
	if (f.isGit === true) return row("project", "ready", `Working in ${tidyPath(f.repo, home)}.`);
	if (f.isGit === false) {
		// `git init` needs Git: without it the Git row comes first.
		return row("project", "todo", "That folder isn't a Git project yet. Make it one?", gitFact.state === "ok" ? act("init-git", "Make it a Git project") : null);
	}
	return row("project", "unknown", "Can't tell if that folder is a Git project.", act("recheck", "Check again"));
}

// facts.figma: null (not checked: never at startup) or { state, message } from crust.figma.status().
function figmaRow(f) {
	const later = "Figma isn't connected. You can do this later.";
	const setup = act("setup-figma", "Set up Figma");
	if (!f) return row("figma", "unknown", "Not checked yet. You can set up Figma later in the Design tab.", setup, { optional: true, checked: false });
	if (f.state === "ready") return row("figma", "ready", "Figma is ready.", null, { optional: true, checked: true });
	if (f.state === "problem") return row("figma", "unknown", "Can't tell. Open Figma desktop and check again.", act("recheck", "Check again"), { optional: true, checked: true });
	if (f.state === "not_reachable") return row("figma", "todo", later, setup, { optional: true, checked: true });
	// connected, but a file, a tab or a selection is missing: phase 4's own words say which
	return row("figma", "todo", f.message || later, setup, { optional: true, checked: true });
}

// What an install has to add, in install order (node, git, pi). Node only matters when Pi has to be installed: a working Pi
// runs on the Node it was installed with.
function needsFrom(facts) {
	const pi = facts.pi || {};
	const needsPi = pi.state === "missing" || (pi.state === "ok" && isOld(pi.version, MIN_PI));
	const node = facts.node || {};
	const nodeBad = node.state === "missing" || (node.state === "ok" && isOld(node.version, MIN_NODE));
	const needs = [];
	if (needsPi && nodeBad) needs.push("node");
	if ((facts.git || {}).state === "missing") needs.push("git");
	if (needsPi) needs.push("pi");
	return needs;
}

function buildHealth(facts, { home } = {}) {
	const pi = facts.pi || { state: "unknown" };
	const git = facts.git || { state: "unknown" };
	const rows = [piRow(pi), authRow(facts.auth || { subs: null }, pi), gitRow(git), projectRow(facts.project || { repo: null }, git, home), figmaRow(facts.figma || null)];
	const required = rows.filter((r) => REQUIRED.includes(r.id));
	const done = required.filter((r) => r.state === "ready").length;
	return { rows, required: REQUIRED.slice(), ready: done === required.length, counts: { done, total: required.length }, needs: needsFrom(facts), facts: publicFacts(facts) };
}

// The facts worth showing the UI: versions and the chosen folder, nothing from auth files, no tokens.
function publicFacts(f) {
	return {
		pi: { state: (f.pi || {}).state || "unknown", version: (f.pi || {}).version || null },
		node: { state: (f.node || {}).state || "unknown", version: (f.node || {}).version || null },
		git: { state: (f.git || {}).state || "unknown", version: (f.git || {}).version || null },
		project: { repo: (f.project || {}).repo || null, isGit: (f.project || {}).isGit ?? null },
		devServer: f.devServer || null,
	};
}

// --- stub (selftest only) --------------------------------------------------------------------------------------------
// PI_CRUST_HEALTH_STUB='{"pi":"missing","auth":"none","git":"ready","project":"none","figma":"not_reachable"}'
// Every key is optional; an omitted one is "ready" (figma: not checked). Same keys as the health:stubSet call.
function stubFacts(s = {}) {
	const pick = (v, d) => (v === undefined ? d : v);
	const tool = (v, ver, oldVer) => {
		if (v === "missing") return { state: "missing", version: null };
		if (v === "unknown") return { state: "unknown", version: null };
		if (v === "old") return { state: "ok", version: oldVer };
		return { state: "ok", version: ver };
	};
	const authKind = pick(s.auth, "ready");
	const claude = (status, extra = {}) => ({ id: "anthropic", label: "Claude", kind: "oauth", status, ...extra });
	const subs =
		authKind === "none" ? { rows: [claude("disconnected", { detail: "Not signed in" })] }
		: authKind === "env" ? { rows: [claude("connected", { authType: "env", detail: "API key (environment variable)" })] }
		: authKind === "unknown" ? { rows: [claude("unavailable", { detail: "Couldn't check" })] }
		: { rows: [claude("connected", { authType: "oauth", detail: "Pro/Max subscription" })] };
	const pj = pick(s.project, "ready");
	const project =
		pj === "none" ? { repo: null, exists: false, isGit: null }
		: pj === "gone" ? { repo: "/stub/gone", exists: false, isGit: null }
		: pj === "notgit" ? { repo: "/stub/notes", exists: true, isGit: false }
		: pj === "unknown" ? { repo: "/stub/site", exists: true, isGit: null }
		: { repo: "/stub/site", exists: true, isGit: true };
	const fg = pick(s.figma, null);
	return {
		pi: tool(s.pi, "1.4.0", "0.73.1"),
		node: tool(s.node, "22.19.0", "20.11.0"),
		git: tool(s.git, "2.47.1", "2.0.0"),
		auth: { subs },
		project,
		figma: fg ? { state: fg, message: fg === "no_file" ? "Figma is open, but no design file is open." : "" } : null,
	};
}

module.exports = { MIN_PI, MIN_NODE, REQUIRED, parseVersion, compareVersions, isOld, tidyPath, buildHealth, needsFrom, stubFacts, piRow, authRow, gitRow, projectRow, figmaRow };
