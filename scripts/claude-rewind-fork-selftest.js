#!/usr/bin/env node
// Runs the self-test step `claude-rewind-fork` (src/claude-rewind-fork-selftest.js) with everything it needs and nothing real:
//   - a temporary git repo (notes.txt) as the project, a temporary user-data folder and Pi folder,
//   - the stand-in SDK (scripts/claude-sdk-stand-in.mjs) with a two-turn script made from the recorded read fixture, and its history rows,
//   - the fake key store and engine of the app (PI_CRUST_SELFTEST_CLAUDE=fake), the window offscreen, no prompt.
// Afterwards it reads the stand-in's SDK log and checks the options the SDK was given: a fork from the end (resume + forkSession) and the rewind in
// the chat's own tab (resume + forkSession + resumeSessionAt = the assistant uuid that ends turn 1).
//   node scripts/claude-rewind-fork-selftest.js [--shots <folder>] [--break]
// --break: PI_CRUST_SELFTEST_CLAUDE_BREAK=1, the step must report MISMATCH (exit 1). Exit 0 only when the step and the log check are OK.
// Never starts the Remote server, never uses a real key, repo or model. The window is offscreen.
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync, execFileSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const args = process.argv.slice(2);
const shotsDir = args.includes("--shots") ? path.resolve(args[args.indexOf("--shots") + 1]) : null;
const BREAK = args.includes("--break");

function twoTurnScript(file) {
	const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
	const turn1 = lines.map((l) => JSON.parse(l));
	// turn 2: the same stream with its own ids (the session stays the same)
	const turn2 = lines.map((l) => JSON.parse(l.replace(/"uuid-/g, '"b-uuid-').replace(/"session_id":"b-uuid-01"/g, '"session_id":"uuid-01"').replace(/"toolu-/g, '"toolu-b-').replace(/"msg-/g, '"msg-b-')));
	return [...turn1, { __await_user: true }, ...turn2];
}
// What getSessionMessages gives for the session: the two turns, the assistant rows carrying the uuids the script's streams end with.
function historyRows(msg1, msg2) {
	const asst = (uuid, id, text) => ({ type: "assistant", uuid, session_id: "uuid-01", parent_tool_use_id: null, timestamp: "2026-01-01T00:00:05.000Z", message: { id, role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text }] } });
	const user = (uuid, text) => ({ type: "user", uuid, session_id: "uuid-01", parent_tool_use_id: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: text } });
	return { "uuid-01": [user("h-u1", msg1), asst("uuid-21", "m1", "Reading notes.txt."), asst("uuid-36", "m2", "notes.txt says: base."), user("h-u2", msg2), asst("b-uuid-36", "m3", "Done: the shell made a file and notes.txt changed.")] };
}

function main() {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pc-rewind-fork-"));
	const started = Date.now();
	const out = { ok: false, lines: [] };
	try {
		const repo = path.join(tmp, "repo");
		fs.mkdirSync(repo);
		const git = (...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@localhost", ...a], { cwd: repo, encoding: "utf8" });
		git("init", "-q");
		git("config", "core.autocrlf", "false");
		fs.writeFileSync(path.join(repo, "notes.txt"), "base\n");
		git("add", "-A");
		git("commit", "-q", "-m", "base");
		const script = path.join(tmp, "script.json");
		const history = path.join(tmp, "history.json");
		const log = path.join(tmp, "sdk-log.jsonl");
		fs.writeFileSync(script, JSON.stringify(twoTurnScript(path.join(__dirname, "claude-fixtures", "read.jsonl"))));
		fs.writeFileSync(history, JSON.stringify(historyRows("Read notes.txt and tell me what it says.", "Now make a file with a shell command and change notes.txt again.")));
		const env = {
			...process.env,
			PI_CRUST_SELFTEST: "1",
			PI_CRUST_SELFTEST_ONLY: "claude-rewind-fork",
			PI_CRUST_SELFTEST_OFFSCREEN: "1",
			PI_CRUST_SELFTEST_NOPROMPT: "1",
			PI_CRUST_SELFTEST_USERDATA: path.join(tmp, "userdata"),
			PI_CODING_AGENT_DIR: path.join(tmp, "pi-agent"),
			PI_CRUST_CWD: repo,
			PI_CRUST_HEALTH_STUB: "{}",
			PI_CRUST_SELFTEST_TIMEOUT: "240000",
			PI_CRUST_SELFTEST_CLAUDE: "fake",
			PI_CRUST_CLAUDE_SDK: path.join(__dirname, "claude-sdk-stand-in.mjs"),
			PI_CRUST_CLAUDE_SCRIPT: script,
			PI_CRUST_CLAUDE_HISTORY: history,
			PI_CRUST_CLAUDE_SDK_LOG: log,
			...(BREAK ? { PI_CRUST_SELFTEST_CLAUDE_BREAK: "1" } : {}),
		};
		fs.mkdirSync(env.PI_CRUST_SELFTEST_USERDATA, { recursive: true });
		fs.mkdirSync(env.PI_CODING_AGENT_DIR, { recursive: true });
		const r = spawnSync(require("electron"), ["."], { cwd: ROOT, env, encoding: "utf8", timeout: 300000, maxBuffer: 50e6 });
		const text = `${r.stdout || ""}\n${r.stderr || ""}`;
		const stepLine = text.split("\n").find((l) => /SELFTEST claude-rewind-fork:/.test(l)) || "";
		out.lines.push(stepLine || "no step line (SELFTEST timeout?)");
		// the step's own report and the "only" line go through console.error too: they are not strays
		const stray = text.split("\n").filter((l) => /\[ui error\]|SELFTEST timeout|MISMATCH/.test(l) && l !== stepLine && !/SELFTEST only: claude-rewind-fork\s*$/.test(l));
		out.lines.push(...stray);
		let logOk = false;
		let why = "no SDK log";
		if (fs.existsSync(log)) {
			const entries = fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.options);
			const forks = entries.filter((e) => e.options.forkSession);
			const pick = (o) => ({ resume: o.resume, forkSession: o.forkSession, resumeSessionAt: o.resumeSessionAt });
			const got = forks.map((e) => pick(e.options));
			const want = [{ resume: "uuid-01", forkSession: true, resumeSessionAt: undefined }, { resume: "uuid-01", forkSession: true, resumeSessionAt: "uuid-36" }];
			logOk = JSON.stringify(got) === JSON.stringify(want);
			why = `SDK options with forkSession: ${JSON.stringify(got)}; wanted ${JSON.stringify(want)}`;
			const chats = entries.filter((e) => e.options.extraArgs && "replay-user-messages" in e.options.extraArgs).length;
			if (chats < 3) {
				logOk = false;
				why += `; only ${chats} chat queries asked for the user-message echo`;
			}
		}
		out.lines.push(`SDK log: ${logOk ? "OK" : "MISMATCH"} (${why})`);
		const stepOk = / -> OK\s*$/.test(stepLine);
		out.ok = BREAK ? /MISMATCH/.test(stepLine) : stepOk && logOk && !stray.length;
		if (shotsDir) {
			fs.mkdirSync(shotsDir, { recursive: true });
			const outDir = path.join(ROOT, "out");
			let n = 0;
			for (const f of fs.readdirSync(outDir)) {
				const p = path.join(outDir, f);
				if (/claude-rewind-fork-.*\.png$/.test(f) && fs.statSync(p).mtimeMs >= started - 1000) {
					fs.copyFileSync(p, path.join(shotsDir, f.replace(/^\d+-/, "")));
					fs.rmSync(p);
					n++;
				}
			}
			out.lines.push(`screenshots: ${n} -> ${shotsDir}`);
		}
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
	console.log(out.lines.join("\n"));
	console.log(out.ok ? "RESULT OK" : "RESULT FAILED");
	process.exit(out.ok ? 0 : 1);
}

main();
