#!/usr/bin/env node
// Runs the self-test step `claude-approval` (src/claude-approval-selftest.js) with everything it needs and nothing real:
//   - a temporary git repo as the project, a temporary user-data folder and Pi folder,
//   - the stand-in SDK (scripts/claude-sdk-stand-in.mjs) with a script of four turns that make tool calls (each runs through the real hook and
//     canUseTool of the adapter) and end like the recorded read fixture,
//   - the fake key store and engine of the app (PI_CRUST_SELFTEST_CLAUDE=fake), the window offscreen, no prompt.
// Afterwards it reads the stand-in's gate log: what each answer did to its call (allow or deny), and that Plan and Trusted asked nobody.
//   node scripts/claude-approval-selftest.js [--shots <folder>] [--break]
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

const tool = (tool_name, tool_input, extra = {}) => ({ __tool_call: { tool_name, tool_input, ...extra } });
const BUILD = tool("Bash", { command: "npm run build" });
const GITCONFIG = tool("Write", { file_path: "<cwd>/.git/config", content: "x" });
// The calls of each turn, in order, and what each must end as. "ask" = it went to canUseTool (the prompt); the hook never decides an ask.
const TURNS = [
	{
		calls: [BUILD, BUILD, BUILD, tool("Bash", { command: "npm run lint" }), tool("Agent", { description: "Run the tests", prompt: "Run the tests" }), tool("Bash", { command: "npm run test" }, { agent_id: "agent-1" }), GITCONFIG],
		want: [["Bash", "allow", true], ["Bash", "allow", true], ["Bash", "allow", true], ["Bash", "deny", true], ["Agent", "allow", true], ["Bash", "deny", true], ["Write", "deny", true]],
	},
	{ calls: [BUILD, tool("Write", { file_path: "<cwd>/notes.txt", content: "x" })], want: [["Bash", "deny", false], ["Write", "deny", false]] }, // Plan: the hook denies, nobody is asked
	{ calls: [BUILD, GITCONFIG], want: [["Bash", "allow", true], ["Write", "allow", true]] }, // Trusted: the hook asks the SDK on, canUseTool allows without a prompt
	{ calls: [tool("Bash", { command: "npm run closing" })], want: [["Bash", "deny", true]] }, // the chat is closed while the prompt is open
];

function script(fixture) {
	const lines = fs.readFileSync(fixture, "utf8").split("\n").filter(Boolean);
	const at = lines.findIndex((l) => l.includes('"uuid-26"'));
	const head = lines.slice(0, 1);
	const tail = lines.slice(at);
	const out = [];
	TURNS.forEach((t, i) => {
		if (i) out.push({ __await_user: true });
		const rename = (l) => JSON.parse(l.replace(/"uuid-/g, `"t${i}-uuid-`).replace(/"msg-02"/g, `"msg-t${i}"`).replace(new RegExp(`"session_id":"t${i}-uuid-01"`, "g"), '"session_id":"uuid-01"'));
		out.push(...head.map(rename), ...t.calls, ...tail.map(rename));
	});
	return out;
}

function main() {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pc-approval-"));
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
		const scriptFile = path.join(tmp, "script.json");
		const log = path.join(tmp, "sdk-log.jsonl");
		fs.writeFileSync(scriptFile, JSON.stringify(script(path.join(__dirname, "claude-fixtures", "read.jsonl"))));
		const env = {
			...process.env,
			PI_CRUST_SELFTEST: "1",
			PI_CRUST_SELFTEST_ONLY: "claude-approval",
			PI_CRUST_SELFTEST_OFFSCREEN: "1",
			PI_CRUST_SELFTEST_NOPROMPT: "1",
			PI_CRUST_SELFTEST_USERDATA: path.join(tmp, "userdata"),
			PI_CODING_AGENT_DIR: path.join(tmp, "pi-agent"),
			PI_CRUST_CWD: repo,
			PI_CRUST_HEALTH_STUB: "{}",
			PI_CRUST_SELFTEST_TIMEOUT: "240000",
			PI_CRUST_SELFTEST_CLAUDE: "fake",
			PI_CRUST_CLAUDE_SDK: path.join(__dirname, "claude-sdk-stand-in.mjs"),
			PI_CRUST_CLAUDE_SCRIPT: scriptFile,
			PI_CRUST_CLAUDE_SDK_LOG: log,
			...(BREAK ? { PI_CRUST_SELFTEST_CLAUDE_BREAK: "1" } : {}),
		};
		fs.mkdirSync(env.PI_CRUST_SELFTEST_USERDATA, { recursive: true });
		fs.mkdirSync(env.PI_CODING_AGENT_DIR, { recursive: true });
		const r = spawnSync(require("electron"), ["."], { cwd: ROOT, env, encoding: "utf8", timeout: 300000, maxBuffer: 50e6 });
		const text = `${r.stdout || ""}\n${r.stderr || ""}`;
		const stepLine = text.split("\n").find((l) => /SELFTEST claude-approval:/.test(l)) || "";
		out.lines.push(stepLine || "no step line (SELFTEST timeout?)");
		const stray = text.split("\n").filter((l) => /\[ui error\]|SELFTEST timeout|MISMATCH/.test(l) && l !== stepLine && !/SELFTEST only: claude-approval\s*$/.test(l));
		out.lines.push(...stray);
		let logOk = false;
		let why = "no SDK log";
		if (fs.existsSync(log)) {
			const gates = fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.gate).map((e) => e.gate);
			const got = gates.map((g) => [g.tool_name, g.outcome, g.viaCanUseTool]);
			const want = TURNS.flatMap((t) => t.want);
			logOk = JSON.stringify(got) === JSON.stringify(want);
			why = `gates [tool, outcome, asked]: ${JSON.stringify(got)}; wanted ${JSON.stringify(want)}`;
			const plan = gates.slice(7, 9);
			if (logOk && !plan.every((g) => g.hooks[0] === "deny" && !g.viaCanUseTool)) {
				logOk = false;
				why += "; Plan was not denied by the hook";
			}
			if (logOk && gates[2].outcome !== "allow") logOk = false;
		}
		out.lines.push(`SDK gate log: ${logOk ? "OK" : "MISMATCH"} (${why})`);
		const stepOk = / -> OK\s*$/.test(stepLine);
		out.ok = BREAK ? /MISMATCH/.test(stepLine) : stepOk && logOk && !stray.length;
		if (shotsDir) {
			fs.mkdirSync(shotsDir, { recursive: true });
			const outDir = path.join(ROOT, "out");
			let n = 0;
			for (const f of fs.readdirSync(outDir)) {
				const p = path.join(outDir, f);
				if (/claude-approval-.*\.png$/.test(f) && fs.statSync(p).mtimeMs >= started - 1000) {
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
