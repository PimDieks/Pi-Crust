#!/usr/bin/env node
// Runs the self-test step `viewer-agent` (src/viewer-agent-selftest.js) with everything it needs and nothing real:
//   - a throwaway git repo as the project (pages, an image, a PDF, a dot file, many pages) and a folder outside it with a secret page,
//   - a temporary user-data folder and Pi folder, the window offscreen, no prompt (no notification, no focus change, nothing on the screen),
//   - the scripted stand-in for Pi (scripts/viewer-agent-fake-pi.js, through PI_CRUST_PI: a script, not a program posing as Pi),
//   - the stand-in SDK (scripts/claude-sdk-stand-in.mjs) with a script of two turns that call the app's tool (each call runs through the real
//     PreToolUse hook and canUseTool and then the real handler), and the fake key store and engine of the app (PI_CRUST_SELFTEST_CLAUDE=fake).
// Afterwards it reads the stand-in SDK's gate log: what the gate did to each call, and that the SDK was handed exactly one server with one tool.
// Never starts the Remote server, never uses a real key, Pi, engine or model. A timeout bounds the run (PI_CRUST_SELFTEST_TIMEOUT and the spawn).
//   node scripts/viewer-agent-selftest.js [--shots <folder>] [--break <name>]
// --break <name>: PI_CRUST_SELFTEST_VIEWER_BREAK=<name> (agent-host, agent-path, agent-focus, agent-reuse, agent-limit, agent-rate); the step must report
// MISMATCH (exit 1 from the step's point of view; this runner exits 0 only when it did, and prints which checks failed).
// Exit 0 only when the step and the log check are OK.
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync, execFileSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const args = process.argv.slice(2);
const shotsDir = args.includes("--shots") ? path.resolve(args[args.indexOf("--shots") + 1]) : null;
const BREAK = args.includes("--break") ? args[args.indexOf("--break") + 1] : "";

const FULL = "mcp__pi-crust__show_in_viewer";
const UNC = "\\\\server\\share\\a.html";
const call = (target) => ({ __tool_call: { tool_name: FULL, tool_input: { target }, emit: true } });
const SCRIPT = [
	{ type: "system", subtype: "init", session_id: "s" },
	call("img/logo.svg"),
	call("http://127.0.0.1:9/"),
	call("../outside/secret.html"),
	call(UNC),
	{ type: "result", subtype: "success", is_error: false, result: "ok", total_cost_usd: 0, session_id: "s" },
	{ __await_user: true },
	{ type: "system", subtype: "init", session_id: "s" },
	call("doc.pdf"),
	{ type: "result", subtype: "success", is_error: false, result: "ok", total_cost_usd: 0, session_id: "s" },
];
// [tool, outcome, asked]: the first three go through the hook's "ask" and canUseTool, which allows without a question; the network path is denied by the hook.
const WANT = [[FULL, "allow", true], [FULL, "allow", true], [FULL, "allow", true], [FULL, "deny", false], [FULL, "allow", true]];

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFUlEQVR4nGP8z8Dwn4EIwESMolGFxCsEAHkDAhFq7qtlAAAAAElFTkSuQmCC", "base64");
const page = (title) => `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:20px sans-serif;margin:24px"><h1>${title}</h1></body>`;

function main() {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pc-viewer-agent-"));
	const started = Date.now();
	const out = { ok: false, lines: [] };
	try {
		const repo = path.join(tmp, "repo");
		const outside = path.join(tmp, "outside");
		const put = (base, rel, data) => {
			fs.mkdirSync(path.dirname(path.join(base, rel)), { recursive: true });
			fs.writeFileSync(path.join(base, rel), data);
		};
		fs.mkdirSync(repo);
		put(repo, "index.html", page("Home"));
		put(repo, "docs/pricing.html", page("Pricing"));
		put(repo, "img/logo.svg", "<svg xmlns='http://www.w3.org/2000/svg' width='120' height='80'><rect width='120' height='80' fill='#3b82c4'/><circle cx='60' cy='40' r='24' fill='#fff'/></svg>");
		put(repo, "img/photo.png", PNG);
		put(repo, "doc.pdf", "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n");
		put(repo, "notes.txt", "notes");
		put(repo, ".env", "KEY=1");
		for (let i = 1; i <= 12; i++) put(repo, `many/page${String(i).padStart(2, "0")}.html`, page(`Page ${i}`));
		put(outside, "secret.html", page("Outside"));
		const git = (...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@localhost", ...a], { cwd: repo, encoding: "utf8" });
		git("init", "-q");
		git("config", "core.autocrlf", "false");
		git("add", "-A");
		git("commit", "-q", "-m", "base");
		const scriptFile = path.join(tmp, "script.json");
		const log = path.join(tmp, "sdk-log.jsonl");
		fs.writeFileSync(scriptFile, JSON.stringify(SCRIPT));
		const env = {
			...process.env,
			PI_CRUST_SELFTEST: "1",
			PI_CRUST_SELFTEST_ONLY: "viewer-agent",
			PI_CRUST_SELFTEST_OFFSCREEN: "1",
			PI_CRUST_SELFTEST_NOPROMPT: "1",
			PI_CRUST_SELFTEST_USERDATA: path.join(tmp, "userdata"),
			PI_CODING_AGENT_DIR: path.join(tmp, "pi-agent"),
			PI_CRUST_CWD: repo,
			PI_CRUST_HEALTH_STUB: "{}",
			PI_CRUST_SELFTEST_TIMEOUT: "540000",
			PI_CRUST_PI: path.join(__dirname, "viewer-agent-fake-pi.js"),
			PI_CRUST_SELFTEST_CLAUDE: "fake",
			PI_CRUST_CLAUDE_SDK: path.join(__dirname, "claude-sdk-stand-in.mjs"),
			PI_CRUST_CLAUDE_SCRIPT: scriptFile,
			PI_CRUST_CLAUDE_SDK_LOG: log,
			PI_CRUST_VA_OUTSIDE: path.join(outside, "secret.html"),
			...(shotsDir ? { PI_CRUST_VA_SHOTDIR: shotsDir } : {}),
			...(BREAK ? { PI_CRUST_SELFTEST_VIEWER_BREAK: BREAK } : {}),
		};
		delete env.PI_CRUST_SELFTEST_NO_PI;
		fs.mkdirSync(env.PI_CRUST_SELFTEST_USERDATA, { recursive: true });
		fs.mkdirSync(env.PI_CODING_AGENT_DIR, { recursive: true });
		const r = spawnSync(require("electron"), ["."], { cwd: ROOT, env, encoding: "utf8", timeout: 600000, maxBuffer: 80e6 });
		const text = `${r.stdout || ""}\n${r.stderr || ""}`;
		const lines = text.split("\n");
		const stepLines = lines.filter((l) => /SELFTEST viewer-agent/.test(l));
		const summary = stepLines.find((l) => /SELFTEST viewer-agent: \d+ checks/.test(l)) || "";
		const failed = stepLines.filter((l) => /MISMATCH/.test(l) && l !== summary);
		out.lines.push(summary || "no summary line (SELFTEST timeout?)");
		out.lines.push(...failed.slice(0, 12));
		const stray = lines.filter((l) => /\[ui error\]|SELFTEST timeout|selftest step .* failed/.test(l) && !/SELFTEST viewer-agent|SELFTEST only: viewer-agent\s*$/.test(l));
		out.lines.push(...stray);
		let logOk = false;
		let why = "no SDK log";
		if (fs.existsSync(log)) {
			const recs = fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
			const gates = recs.filter((e) => e.gate).map((e) => e.gate);
			const got = gates.map((g) => [g.tool_name, g.outcome, g.viaCanUseTool]);
			const servers = recs.filter((e) => e.options && e.options.mcpServers).map((e) => e.options.mcpServers);
			const oneTool = servers.length > 0 && servers.every((m) => JSON.stringify(m) === JSON.stringify({ "pi-crust": { type: "sdk", tools: ["show_in_viewer"] } }));
			logOk = JSON.stringify(got) === JSON.stringify(WANT) && oneTool;
			why = `gates [tool, outcome, asked]: ${JSON.stringify(got)}; wanted ${JSON.stringify(WANT)}; the SDK got ${JSON.stringify(servers[0])} (one server, one tool: ${oneTool})`;
		}
		out.lines.push(`SDK gate log: ${logOk ? "OK" : "MISMATCH"} (${why})`);
		const stepOk = / all OK\s*$/.test(summary);
		out.ok = BREAK ? /MISMATCH/.test(summary) || !logOk : stepOk && logOk && !stray.length;
		if (shotsDir) {
			const n = fs.existsSync(shotsDir) ? fs.readdirSync(shotsDir).filter((f) => /^va-.*\.png$/.test(f) && fs.statSync(path.join(shotsDir, f)).mtimeMs >= started - 1000).length : 0;
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
