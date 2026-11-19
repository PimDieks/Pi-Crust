// Busy detection for a Windows terminal. node-pty's `process` is only the terminal name there, so ask Windows instead: the shell is
// busy while it has a live child process other than the console host (conhost.exe / OpenConsole.exe, which ConPTY keeps around).
// One short-lived hidden powershell.exe per check, a hard time limit (the check then reports "unknown" and the caller keeps today's
// behaviour: not busy), and never two checks at once for the same shell. A command that is a shell builtin or cmdlet (Start-Sleep, cd)
// starts no process and is not seen as busy.
"use strict";

const path = require("node:path");
const { spawn } = require("node:child_process");

const IGNORED = new Set(["conhost.exe", "openconsole.exe", "wslhost.exe"]);
const LIMIT_MS = 3000;

// rows: [{ Name, ProcessId }] of the direct children of the shell. -> name of the first real child without ".exe", or null.
function busyName(rows) {
	for (const r of rows || []) {
		const n = String((r && r.Name) || "");
		if (!n || IGNORED.has(n.toLowerCase())) continue;
		return n.replace(/\.exe$/i, "");
	}
	return null;
}

function parse(out) {
	const t = String(out || "").trim();
	if (!t) return [];
	const j = JSON.parse(t);
	return Array.isArray(j) ? j : [j];
}

// cb(name | null | undefined): a name = busy, null = idle, undefined = could not tell (error, timeout). Returns a cancel function.
function check(pid, cb, { limitMs = LIMIT_MS } = {}) {
	const ps = path.join(process.env.SystemRoot || "C:\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
	const cmd = `Get-CimInstance Win32_Process -Filter 'ParentProcessId=${Number(pid) | 0}' | Select-Object Name,ProcessId | ConvertTo-Json -Compress`;
	let done = false;
	let out = "";
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
	const timer = setTimeout(() => {
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
			finish(busyName(parse(out)));
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

module.exports = { busyName, parse, check };
