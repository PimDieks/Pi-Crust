#!/usr/bin/env node
// Characterization runner: replays scripted agent transcripts through the real app (one scenario per launch, offscreen,
// no prompt) and compares what the main process emitted, and what the app wrote to the agent, with the golden files.
//
//   node scripts/char/run.js <scenario|all> [--update] [--root <app root>] [--transcripts <dir>] [--golden <dir>] [--keep]
//
// A run = `npm run selftest -- char` with PI_CRUST_SELFTEST_OFFSCREEN=1 and PI_CRUST_SELFTEST_NOPROMPT=1 ADDED to the normal
// environment, PI_CRUST_PI pointing at scripts/char/fake-agent.js (the stand-in), PI_CRUST_CWD at a throwaway git repo and
// PI_CODING_AGENT_DIR at an empty temp folder. The recorder plugin is copied to <root>/src/local/ for the run and removed after.
// Exit code: 0 = every scenario identical to golden (or golden written with --update), 1 = a difference or a failed run.
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const HERE = __dirname;
const PLUGIN_FILES = ["char-main.js", "char-step.js"];

// --- normalisation and comparison (pure) -------------------------------------------------------------------------
// tokens: [[absolute path, "<TOKEN>"], ...]. Every spelling of a path (native, forward slashes, lower case) becomes the token.
function pathVariants(p) {
	const out = new Set();
	for (const base of [p, path.resolve(p)]) {
		out.add(base);
		out.add(base.replace(/\\/g, "/"));
	}
	return [...out].filter(Boolean);
}
function normalizeString(s, tokens) {
	let r = s;
	for (const [p, token] of tokens) {
		for (const v of pathVariants(p)) {
			const re = new RegExp(v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?=[\\\\/\"']|$|\\s)", "gi");
			r = r.replace(re, token);
		}
	}
	// what follows a token is a path: one separator style
	return r.replace(/(<[A-Z_]+>)([\\/][^\s"']*)/g, (_m, t, rest) => t + rest.replace(/\\/g, "/"));
}
function normalizeValue(v, tokens) {
	if (typeof v === "string") return normalizeString(v, tokens);
	if (Array.isArray(v)) return v.map((x) => normalizeValue(x, tokens));
	if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, normalizeValue(x, tokens)]));
	return v;
}
const readJsonl = (f) =>
	fs.existsSync(f)
		? fs
				.readFileSync(f, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((l) => JSON.parse(l))
		: [];
// One text per scenario (see the notes in buildCapture): "E" lines are main-process events and driver steps in order, "S" lines the pi:stderr events (own sequence), "P<n>" lines are what process n of the
// stand-in saw and said (argv, cwd, env values, every line in and out). Compact JSON, one entry per line, no timestamps.
function buildCapture({ events, procs }, tokens) {
	const lines = [];
	// stderr and stdout are separate pipes: the app gets no guaranteed order between them, so pi:stderr events are
	// compared as their own sequence (S lines) and not against the other events.
	const isErr = (e) => e.channel === "pi:stderr";
	// pi:started carries { agent: { id, label, capabilities } } since phase 6 step S7 (additive, nothing displays it). It is left out of the
	// comparison so the golden files taken before S7 stay valid; scripts/char.test.js pins this one exception.
	const plain = (e) => (e.channel === "pi:started" && e.payload && "agent" in e.payload ? { ...e, payload: Object.fromEntries(Object.entries(e.payload).filter(([k]) => k !== "agent")) } : e);
	for (const e of events.filter((x) => !isErr(x)).map(plain)) lines.push(`E ${JSON.stringify(normalizeValue(e, tokens))}`);
	for (const e of events.filter(isErr)) lines.push(`S ${JSON.stringify(normalizeValue(e, tokens))}`);
	// Agent processes (started with --mode rpc) are numbered in start order (P lines). Helper processes the app starts on its own
	// (the health check: `--version`, `auth check --provider X`) run in parallel, so their start order is not defined: they are
	// compared as a set, sorted (H lines).
	const isChat = (entries) => !!(entries[0] && Array.isArray(entries[0].argv) && entries[0].argv.includes("--mode"));
	let n = 0;
	const helpers = [];
	for (const entries of procs) {
		if (isChat(entries)) {
			n++;
			for (const e of entries) lines.push(`P${n} ${JSON.stringify(normalizeValue(e, tokens))}`);
		} else helpers.push(entries.map((e) => JSON.stringify(normalizeValue(e, tokens))).join("\n"));
	}
	helpers.sort().forEach((h, i) => h.split("\n").forEach((l) => lines.push(`H${i + 1} ${l}`)));
	return lines.join("\n") + "\n";
}
// Line diff (LCS). Returns [] when identical, else hunks like "- old" / "+ new" with 2 lines of context.
function diffLines(a, b) {
	const x = a.split("\n");
	const y = b.split("\n");
	if (a === b) return [];
	const n = x.length;
	const m = y.length;
	const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
	for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
	const ops = [];
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (x[i] === y[j]) (ops.push([" ", x[i]]), i++, j++);
		else if (dp[i + 1][j] >= dp[i][j + 1]) ops.push(["-", x[i++]]);
		else ops.push(["+", y[j++]]);
	}
	while (i < n) ops.push(["-", x[i++]]);
	while (j < m) ops.push(["+", y[j++]]);
	const keep = new Set();
	ops.forEach(([k], idx) => {
		if (k !== " ") for (let d = -2; d <= 2; d++) keep.add(idx + d);
	});
	const out = [];
	let last = -1;
	ops.forEach(([k, line], idx) => {
		if (!keep.has(idx)) return;
		if (last >= 0 && idx !== last + 1) out.push("  ...");
		out.push(`${k} ${line}`);
		last = idx;
	});
	return out;
}

// --- a run -------------------------------------------------------------------------------------------------------
function killTree(child) {
	try {
		if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
		else process.kill(-child.pid, "SIGKILL");
	} catch {}
}

async function runScenario(name, o) {
	const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pi-crust-char-")));
	const repo = path.join(tmp, "repo");
	const agentDir = path.join(tmp, "agent");
	const logDir = path.join(tmp, "proc");
	const outFile = path.join(tmp, "events.jsonl");
	fs.mkdirSync(repo);
	fs.mkdirSync(agentDir);
	const git = (...a) => spawnSync("git", a, { cwd: repo, stdio: "ignore" });
	fs.writeFileSync(path.join(repo, "README.md"), "# Char fixture\n");
	git("init", "-q");
	git("-c", "user.name=char", "-c", "user.email=char@example.invalid", "add", ".");
	git("-c", "user.name=char", "-c", "user.email=char@example.invalid", "commit", "-q", "-m", "fixture");
	const transcript = path.join(o.transcripts, `${name}.json`);
	const localDir = path.join(o.root, "src", "local");
	const hadLocal = fs.existsSync(localDir);
	if (hadLocal) {
		const other = fs.readdirSync(localDir).filter((f) => !PLUGIN_FILES.includes(f));
		if (other.length) throw new Error(`${localDir} holds other local plugins (${other.join(", ")}); they would change the capture. Use a clean worktree.`);
	}
	fs.mkdirSync(localDir, { recursive: true });
	for (const f of PLUGIN_FILES) fs.copyFileSync(path.join(HERE, "plugin", f), path.join(localDir, f));
	const T = JSON.parse(fs.readFileSync(transcript, "utf8"));
	const env = {
		...process.env,
		PI_CRUST_SELFTEST_OFFSCREEN: "1",
		PI_CRUST_SELFTEST_NOPROMPT: "1",
		PI_CRUST_SELFTEST_TIMEOUT: "120000",
		PI_CRUST_PI: path.join(HERE, "fake-agent.js"),
		PI_CRUST_CWD: repo,
		PI_CODING_AGENT_DIR: agentDir,
		PI_CRUST_SELFTEST_USERDATA: path.join(tmp, "userdata"), // fresh settings and recent projects for every run
		PI_CRUST_CHAR_SCENARIO: name,
		PI_CRUST_CHAR_TRANSCRIPT: transcript,
		PI_CRUST_CHAR_OUT: outFile,
		PI_CRUST_CHAR_LOGDIR: logDir,
		...(T.env || {}), // per-scenario switches (for example PI_CRUST_SELFTEST_NO_PI=1)
	};
	let log = "";
	let code;
	try {
		code = await new Promise((resolve) => {
			const child = spawn("npm", ["run", "selftest", "--", "char"], { cwd: o.root, env, shell: true, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
			const timer = setTimeout(() => (killTree(child), resolve("timeout")), 150_000);
			child.stdout.on("data", (d) => (log += d));
			child.stderr.on("data", (d) => (log += d));
			child.on("exit", (c) => (clearTimeout(timer), resolve(c)));
		});
	} finally {
		for (const f of PLUGIN_FILES) fs.rmSync(path.join(localDir, f), { force: true });
		if (!hadLocal) fs.rmSync(localDir, { recursive: true, force: true });
	}
	const events = readJsonl(outFile);
	const procs = fs.existsSync(logDir)
		? fs
				.readdirSync(logDir)
				.filter((f) => /^proc-\d+\.jsonl$/.test(f))
				.sort((a, b) => parseInt(a.slice(5)) - parseInt(b.slice(5)))
				.map((f) => readJsonl(path.join(logDir, f)))
		: [];
	const tokens = [
		[repo, "<REPO>"],
		[agentDir, "<AGENT_DIR>"],
		[tmp, "<TMP>"],
		[o.root, "<APP>"],
	];
	const capture = buildCapture({ events, procs }, tokens);
	const problems = [];
	if (code !== 0) problems.push(`app exited with ${code}`);
	if (!events.some((e) => e.src === "drive")) problems.push("the driver never ran (no drive entries)");
	if (events.some((e) => e.src === "drive" && e.error)) problems.push(`driver error: ${events.find((e) => e.error).error}`);
	if (!o.keep) fs.rmSync(tmp, { recursive: true, force: true });
	return { capture, log, problems, tmp };
}

async function main(argv) {
	const args = { scenarios: [], update: false, keep: false, root: path.resolve(HERE, "..", ".."), transcripts: path.join(HERE, "transcripts"), golden: path.join(HERE, "golden") };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--update") args.update = true;
		else if (a === "--keep") args.keep = true;
		else if (a === "--root") args.root = path.resolve(argv[++i]);
		else if (a === "--transcripts") args.transcripts = path.resolve(argv[++i]);
		else if (a === "--golden") args.golden = path.resolve(argv[++i]);
		else args.scenarios.push(a);
	}
	if (!args.scenarios.length) {
		console.error("usage: node scripts/char/run.js <scenario|all> [--update] [--root dir] [--transcripts dir] [--golden dir] [--keep]");
		return 2;
	}
	const all = fs
		.readdirSync(args.transcripts)
		.filter((f) => f.endsWith(".json"))
		.map((f) => f.slice(0, -5))
		.sort();
	const names = args.scenarios.includes("all") ? all : args.scenarios;
	let failed = 0;
	for (const name of names) {
		if (!all.includes(name)) {
			console.error(`unknown scenario ${name} (known: ${all.join(", ")})`);
			return 2;
		}
		const r = await runScenario(name, args);
		const file = path.join(args.golden, `${name}.txt`);
		if (r.problems.length) {
			failed++;
			console.log(`FAIL ${name}: ${r.problems.join("; ")}`);
			console.log(r.log.split("\n").slice(-15).join("\n"));
			continue;
		}
		if (args.update) {
			fs.mkdirSync(args.golden, { recursive: true });
			fs.writeFileSync(file, r.capture);
			console.log(`WROTE ${name} (${r.capture.split("\n").length - 1} lines)`);
			continue;
		}
		const want = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\r\n").join("\n") : null; // git may check the file out with CRLF
		const d = want === null ? ["no golden file"] : diffLines(want, r.capture);
		if (d.length) {
			failed++;
			console.log(`DIFF ${name}: ${d.filter((l) => /^[+-] /.test(l)).length} differing line(s)`);
			console.log(d.slice(0, 40).map((l) => l.slice(0, 400)).join("\n"));
		} else console.log(`SAME ${name} (${r.capture.split("\n").length - 1} lines)`);
	}
	console.log(failed ? `${failed} of ${names.length} scenario(s) differ or failed` : `all ${names.length} scenario(s) identical`);
	return failed ? 1 : 0;
}

if (require.main === module) main(process.argv.slice(2)).then((c) => process.exit(c));
module.exports = { normalizeString, normalizeValue, buildCapture, diffLines };
