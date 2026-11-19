#!/usr/bin/env node
"use strict";
// The restart checks of the selftest step `viewer-tabs` (remembered Viewer tabs): the app is launched TWICE with the same data folder.
//   launch 1 (PI_CRUST_VT_PHASE=save)    builds the tabs of a project folder that outlives the run; the app's own quit saves them.
//   between                               this script removes one project file and adds tampered entries to settings.json.
//   launch 2 (PI_CRUST_VT_PHASE=restore) checks the restored tabs (order, active, lazy loading, the missing file, the tampered entries gone).
// Offscreen, no prompt to any model, fresh temporary folders for the data folder, Pi's agent folder and the project; nothing on the screen.
// Usage: node scripts/viewer-tabs-restart.js [--break=tabs-forget] [--shots=<folder>]
// The deliberate break (nothing is remembered) must make it exit with 1.
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.join(__dirname, "..");
const arg = (name) => (process.argv.find((a) => a.startsWith(`--${name}=`)) || "").slice(name.length + 3);
const breakMode = arg("break");
const shots = arg("shots");
const timeout = Number(process.env.PI_CRUST_SELFTEST_TIMEOUT || 300000);

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-crust-vt-restart-")));
const data = path.join(tmp, "data");
const agent = path.join(tmp, "agent");
const project = path.join(tmp, "project");
for (const d of [data, agent, project]) fs.mkdirSync(d, { recursive: true });

function launch(phase) {
	const env = {
		...process.env,
		PI_CRUST_SELFTEST: "1",
		PI_CRUST_SELFTEST_ONLY: "viewer-tabs",
		PI_CRUST_SELFTEST_OFFSCREEN: "1",
		PI_CRUST_SELFTEST_NOPROMPT: "1",
		PI_CRUST_SELFTEST_USERDATA: data,
		PI_CODING_AGENT_DIR: agent,
		PI_CRUST_SELFTEST_TIMEOUT: String(timeout),
		PI_CRUST_VT_PHASE: phase,
		PI_CRUST_VT_PROJECT: project,
		...(shots ? { PI_CRUST_VT_SHOTDIR: shots } : {}),
		...(breakMode ? { PI_CRUST_SELFTEST_VIEWER_BREAK: breakMode } : {}),
	};
	const r = spawnSync(require("electron"), ["."], { cwd: root, env, encoding: "utf8", timeout: timeout + 60000, maxBuffer: 100e6 });
	const out = `${r.stdout || ""}\n${r.stderr || ""}`;
	const lines = out.split(/\r?\n/).filter((l) => /SELFTEST viewer-tabs/.test(l));
	const summary = lines.filter((l) => /SELFTEST viewer-tabs: \d+ checks/.test(l)).pop() || "";
	const bad = lines.filter((l) => /MISMATCH/.test(l));
	console.log(`--- launch ${phase}: ${summary || "NO SUMMARY (timeout or crash)"}`);
	for (const l of lines) if (/MISMATCH/.test(l) && !/checks,/.test(l)) console.log(l.replace(/^.*SELFTEST /, "SELFTEST "));
	if (!summary || /SELFTEST timeout/.test(out)) console.log((out.split(/\r?\n/).filter((l) => /timeout|Error|error/i.test(l)).slice(0, 8)).join("\n"));
	return { ok: !!summary && bad.length === 0, summary, bad, lines };
}

const projectKey = () => require(path.join(root, "src", "figma-main")).repoKey(project);

function tamper() {
	// A file of the project is deleted while the app is closed.
	fs.rmSync(path.join(project, "gone.html"), { force: true });
	// Entries in settings.json that a person (or a bug) could have written: the app must drop every one of them.
	const file = path.join(data, "settings.json");
	const settings = JSON.parse(fs.readFileSync(file, "utf8"));
	const entry = settings.viewerTabs && settings.viewerTabs[projectKey()];
	if (!entry) throw new Error("launch 1 stored nothing for the project (" + projectKey() + "): " + JSON.stringify(settings.viewerTabs));
	const other = require(path.join(root, "src", "project-files")).hostFor(path.join(tmp, "elsewhere"));
	const bad = [
		{ address: "file:///C:/Users/alex/secret.html", title: "file address" },
		{ address: `pi-project://${other}/a.html`, title: "another project's address" },
		{ path: "../outside.html", title: "dot dot" },
		{ path: "docs/../a.html", title: "dot dot inside" },
		{ path: "a\\..\\..\\x.html", title: "dot dot with backslashes" },
		{ path: ".git/config.html", title: "dot folder" },
		{ address: "javascript:alert(1)", title: "script" },
		{ address: "data:text/html,<p>x</p>", title: "data" },
		{ path: "notes.txt", title: "a type the Viewer does not show" },
		{ path: "", title: "empty" },
		{ title: "no address" },
		"just a string",
		null,
		42,
		{ path: "x".repeat(2000) + ".html", title: "too long" },
	];
	entry.tabs = [bad[0], ...entry.tabs, ...bad.slice(1)];
	entry.active += 1; // the active entry moved one place down
	fs.writeFileSync(file, JSON.stringify(settings, null, 2));
	return { entries: entry.tabs.length, active: entry.active };
}

let ok = true;
try {
	console.log(`data folder ${data}${breakMode ? `, deliberate break: ${breakMode}` : ""}`);
	const one = launch("save");
	ok = ok && one.ok;
	if (one.ok || breakMode) {
		let t;
		try { t = tamper(); } catch (e) { console.log("tamper step failed: " + e.message); ok = false; }
		if (t) {
			console.log(`--- tampered: ${t.entries} stored entries (6 real, 15 not), active index ${t.active}, gone.html deleted`);
			const two = launch("restore");
			ok = ok && two.ok;
		}
	}
} finally {
	try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
}
console.log(ok ? "viewer-tabs restart: all OK" : "viewer-tabs restart: MISMATCH");
process.exit(ok ? 0 : 1);
