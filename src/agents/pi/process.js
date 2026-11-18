// The Pi process driver (phase 6: moved out of main.js, same behaviour). Spawns `pi --mode rpc`, frames its JSONL output (split on
// LF only, never readline), probes until Pi answers, and stops it. Everything the app has to know goes through the sink; this file
// knows nothing about chats, windows or the renderer.
//
// Sink (all called synchronously, in the order things happen; `handle` is the child process):
//   isCurrent(handle)         false once the handle was replaced, its chat closed or the repo changed: its events are dropped
//   ready(handle, data)       Pi answered the probe; `data` is the get_state data
//   record(handle, record)    one record from Pi (the probe's own reply is never forwarded). May throw: it is reported as stderr text
//   stderr(handle, text)      a chunk of stderr, or "Unparseable record: ..."
//   exit(handle, info)        info: { kind: "timeout", error } (no answer within READY_TIMEOUT_MS; the driver stops the process right after),
//                             { kind: "error", error, errorCode } (could not spawn), { kind: "exit", code, signal }
//                             Called even for a replaced handle (the app must fail its pending requests first); the app checks isCurrent itself.
"use strict";

const { spawn } = require("node:child_process");
const path = require("node:path");
const { killTree } = require("../../kill-tree");

const IS_WIN = process.platform === "win32";

// Pi answers nothing until asked, and runs extension session_start hooks before reading stdin, so readiness is the
// correlated reply to a repeated cheap probe (get_state), not the first byte of output.
const PROBE_ID = "__ready_probe__";
const PROBE_INTERVAL_MS = 750;
const READY_TIMEOUT_MS = 120_000;

// The four extensions the app injects (crust-context.ts reports the context breakdown and models used; crust-guard.ts asks to
// continue after every N tool calls; advisor.ts adds Anthropic's advisor tool; permission-modes.ts enforces the permission mode).
const EXTENSIONS = ["crust-context.ts", "crust-guard.ts", "advisor.ts", "permission-modes.ts"];
const EXTENSION_DIR = path.join(__dirname, "..", "..", "pi-extension");

function stop(proc) {
	if (!proc || proc.exitCode !== null) return;
	try {
		proc.stdin.end(); // orderly shutdown request
	} catch {}
	const group = () => {
		try {
			killTree(proc); // the whole group: subagents and running commands too
		} catch {}
	};
	setTimeout(() => proc.exitCode === null && group(), 1500);
	setTimeout(() => {
		if (proc.exitCode === null) {
			try {
				killTree(proc, true);
			} catch {}
		}
	}, 4500);
}

// opts: { pi: { command, args }, cwd, env, sessionRef? }. Returns the child process (the handle).
function start(opts, sink) {
	const args = ["--mode", "rpc", ...EXTENSIONS.flatMap((f) => ["-e", path.join(EXTENSION_DIR, f)])];
	if (opts.sessionRef) args.push("--session", opts.sessionRef);
	const [cmd, cmdArgs] = [opts.pi.command, [...opts.pi.args, ...args]];
	// Windows: no process groups, and detached would open a console window.
	const proc = spawn(cmd, cmdArgs, { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "pipe"], detached: !IS_WIN, windowsHide: true });
	const current = () => sink.isCurrent(proc);
	let ready = false;
	const started = Date.now();
	const probe = setInterval(() => {
		if (ready || !current()) return clearInterval(probe);
		if (Date.now() - started > READY_TIMEOUT_MS) {
			clearInterval(probe);
			sink.exit(proc, { kind: "timeout", error: `Pi did not answer within ${READY_TIMEOUT_MS / 1000}s` });
			stop(proc);
			return;
		}
		if (proc.stdin.writable) proc.stdin.write(JSON.stringify({ id: PROBE_ID, type: "get_state" }) + "\n");
	}, PROBE_INTERVAL_MS);
	let buf = "";
	proc.stdout.setEncoding("utf8");
	proc.stdout.on("data", (chunk) => {
		if (!current()) return; // a replaced process
		buf += chunk;
		let nl;
		while ((nl = buf.indexOf("\n")) >= 0) {
			let line = buf.slice(0, nl);
			buf = buf.slice(nl + 1);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			if (!line.trim()) continue;
			try {
				const record = JSON.parse(line);
				if (record.id === PROBE_ID) {
					if (!ready) {
						ready = true;
						clearInterval(probe);
						sink.ready(proc, record.data || {});
					}
					continue;
				}
				sink.record(proc, record);
			} catch (e) {
				sink.stderr(proc, `Unparseable record: ${line.slice(0, 200)}`);
			}
		}
	});
	proc.stderr.setEncoding("utf8");
	proc.stderr.on("data", (d) => {
		if (!current()) return; // a replaced process
		sink.stderr(proc, d);
	});
	proc.on("error", (e) => {
		clearInterval(probe);
		sink.exit(proc, { kind: "error", error: e.message, errorCode: e.code });
	});
	proc.on("exit", (code, signal) => {
		clearInterval(probe);
		sink.exit(proc, { kind: "exit", code, signal });
	});
	return proc;
}

module.exports = { start, stop, PROBE_ID, PROBE_INTERVAL_MS, READY_TIMEOUT_MS };
