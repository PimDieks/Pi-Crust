// Busy detection for Windows terminals. node-pty's `process` is only the terminal name there, so ask Windows instead: a shell is busy
// while it has a live descendant process that is not the console host (conhost.exe / OpenConsole.exe, which ConPTY keeps around).
// ONE short-lived hidden powershell.exe lists all processes once and every terminal is answered from that list, with a hard time limit
// (then "unknown" and the caller keeps the state it had). A shell that starts a copy of itself as a wrapper (Git Bash: bin\bash.exe starts
// usr\bin\bash.exe) is looked through, not counted. A builtin or cmdlet (Start-Sleep, cd) starts no process and is not seen as busy.
"use strict";

const path = require("node:path");
const { spawn } = require("node:child_process");

const IGNORED = new Set(["conhost.exe", "openconsole.exe", "wslhost.exe"]);
const LIMIT_MS = 3000;

// procs: [{ Name, ProcessId, ParentProcessId }] of all processes; shells: [{ pid, exe }] (exe: the shell's file name, e.g. "bash.exe").
// -> Map pid -> name of the first real descendant without ".exe", or null when idle.
function busyByShell(procs, shells) {
	const kids = new Map();
	for (const r of procs || []) {
		const pp = Number(r && r.ParentProcessId);
		if (!kids.has(pp)) kids.set(pp, []);
		kids.get(pp).push(r);
	}
	const out = new Map();
	for (const { pid, exe } of shells || []) {
		const own = String(exe || "").toLowerCase();
		let found = null;
		const seen = new Set([Number(pid)]);
		const walk = (p) => {
			for (const r of kids.get(p) || []) {
				const id = Number(r.ProcessId), n = String(r.Name || "");
				if (found || !n || seen.has(id)) continue;
				seen.add(id);
				const low = n.toLowerCase();
				if (IGNORED.has(low)) continue;
				if (own === "bash.exe" && low === own) walk(id); // Git Bash's wrapper copy of itself: look through it (idle subtree = idle)
				else found = n.replace(/\.exe$/i, "");
			}
		};
		walk(Number(pid));
		out.set(pid, found);
	}
	return out;
}

function parse(out) {
	const t = String(out || "").trim();
	if (!t) return [];
	const j = JSON.parse(t);
	return Array.isArray(j) ? j : [j];
}

// cb(Map pid -> name | null) or cb(undefined) when it could not tell (error, timeout). Returns a cancel function.
function checkAll(shells, cb, { limitMs = LIMIT_MS } = {}) {
	const ps = path.join(process.env.SystemRoot || "C:\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
	const cmd = "Get-CimInstance Win32_Process -Property Name,ProcessId,ParentProcessId | Select-Object Name,ProcessId,ParentProcessId | ConvertTo-Json -Compress";
	let done = false;
	let out = "";
	let timer = null;
	const finish = (v) => {
		if (done) return;
		done = true;
		clearTimeout(timer);
		cb(v);
	};
	let child;
	try {
		child = spawn(ps, ["-NoProfile", "-NonInteractive", "-Command", cmd], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
	} catch {
		cb(undefined);
		return () => {};
	}
	timer = setTimeout(() => {
		try {
			child.kill();
		} catch {}
		finish(undefined);
	}, limitMs);
	child.stdout.on("data", (d) => (out += d));
	child.on("error", () => finish(undefined));
	child.on("close", (code) => {
		if (code !== 0) return finish(undefined);
		try {
			finish(busyByShell(parse(out), shells));
		} catch {
			finish(undefined);
		}
	});
	return () => {
		try {
			child.kill();
		} catch {}
		finish(undefined);
	};
}

module.exports = { busyByShell, parse, checkAll };
