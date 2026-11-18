#!/usr/bin/env node
// Stand-in agent for the characterization harness (scripts/char/README is this header). TEST TOOL ONLY.
// It speaks the same strict JSONL RPC as Pi and replays a scripted transcript. It is used only when a harness run points
// PI_CRUST_PI at this file; it is never installed, renamed or shipped as a binary, and it never touches ~/.pi or any auth file.
//
//   PI_CRUST_CHAR_SCENARIO   name of scripts/char/transcripts/<name>.json (required)
//   PI_CRUST_CHAR_TRANSCRIPT optional full path of the transcript (the runner sets it)
//   PI_CRUST_CHAR_LOGDIR     folder for proc-<n>.jsonl: argv, cwd, selected env, every line in and out (no timestamps)
//
// `fake-agent.js auth check --provider X --json --no-refresh` answers like `pi auth check` ("not signed in") and logs its argv.
//
// Transcript: { name, synthetic, state, messages, models, responses: { <type>: data }, rules: [ { on: {type, ...fields}, respond, emit: [...] } ] }
// "ignoreStdinEnd": true keeps the process alive after stdin closes (the app has to kill it).
// A rule matches a request when every field of `on` equals the request's field. `respond: false` sends no response record; `data` sets the response data.
// emit items, in order: a record (object with `type`), { delay: ms }, { wait_ui: id } (pause until that extension_ui_response arrives),
// { stderr: text }, { raw: text } (written as is: partial lines, CRLF, junk), { exit: code }.
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const argv = process.argv.slice(2);
const logDir = process.env.PI_CRUST_CHAR_LOGDIR;
let logFile = null;
let seq = 0;
const log = (entry) => {
	if (!logFile) return;
	fs.appendFileSync(logFile, JSON.stringify({ seq: ++seq, ...entry }) + "\n");
};
if (logDir) {
	fs.mkdirSync(logDir, { recursive: true });
	for (let n = 1; !logFile; n++) {
		const f = path.join(logDir, `proc-${n}.jsonl`);
		try {
			fs.writeFileSync(f, "", { flag: "wx" });
			logFile = f;
		} catch (e) {
			if (e.code !== "EEXIST") throw e;
		}
	}
}
log({ dir: "meta", argv, cwd: process.cwd(), env: { PI_CRUST_TOOL_CHECKIN: process.env.PI_CRUST_TOOL_CHECKIN ?? null, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR ?? null } });

// Pi's own `auth check`: exit 1 means "not ready" and still prints the JSON.
if (argv[0] === "auth") {
	const i = argv.indexOf("--provider");
	process.stdout.write(JSON.stringify({ status: "not_ready", reason: "credentials_not_configured", provider: i >= 0 ? argv[i + 1] : null }) + "\n");
	process.exit(1);
}

const name = process.env.PI_CRUST_CHAR_SCENARIO;
if (!name || !/^[\w-]+$/.test(name)) {
	process.stderr.write("fake-agent: PI_CRUST_CHAR_SCENARIO is not set\n");
	process.exit(2);
}
const T = JSON.parse(fs.readFileSync(process.env.PI_CRUST_CHAR_TRANSCRIPT || path.join(__dirname, "transcripts", `${name}.json`), "utf8"));
const sessionArg = argv.indexOf("--session") >= 0 ? argv[argv.indexOf("--session") + 1] : null;
const state = { ...(T.state || {}), sessionFile: sessionArg || T.state?.sessionFile || "/char/session.jsonl" };

const defaults = {
	get_state: state,
	get_messages: { messages: T.messages || [] },
	get_available_models: { models: T.models || [] },
	clear_queue: { steering: [], followUp: [] },
};

const out = (s) => {
	log({ dir: "out", data: s });
	process.stdout.write(s);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uiWaiters = new Map(); // id -> resolve
const uiSeen = new Set();
let chain = Promise.resolve();
const enqueue = (fn) => (chain = chain.then(fn).catch((e) => process.stderr.write(`fake-agent error: ${e.stack}\n`)));

async function emit(list) {
	for (const item of list) {
		if (item.delay) await sleep(item.delay);
		else if (item.wait_ui) {
			if (!uiSeen.has(item.wait_ui)) await new Promise((r) => uiWaiters.set(item.wait_ui, r));
		} else if (item.stderr !== undefined) {
			log({ dir: "err", data: item.stderr });
			process.stderr.write(item.stderr);
		} else if (item.raw !== undefined) out(item.raw);
		else if (item.exit !== undefined) {
			await sleep(20);
			log({ dir: "meta", exit: item.exit });
			process.exit(item.exit);
		} else out(JSON.stringify(item) + "\n");
	}
}

function handle(req) {
	if (req.type === "extension_ui_response") {
		uiSeen.add(req.id);
		const w = uiWaiters.get(req.id);
		if (w) (uiWaiters.delete(req.id), w());
	}
	const rule = (T.rules || []).find((r) => Object.entries(r.on || {}).every(([k, v]) => req[k] === v));
	if (req.type === "extension_ui_response" && !rule) return; // Pi sends no response to these
	// The response goes out at once (Pi answers while a run streams); the rule's records follow in order.
	if (!rule || rule.respond !== false) {
		const data = rule && "data" in rule ? rule.data : T.responses && req.type in T.responses ? T.responses[req.type] : defaults[req.type] ?? null;
		out(JSON.stringify({ type: "response", id: req.id, command: req.type, success: true, data }) + "\n");
	}
	if (rule?.emit?.length) enqueue(() => emit(rule.emit));
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buf += chunk;
	let nl;
	while ((nl = buf.indexOf("\n")) >= 0) {
		const line = buf.slice(0, nl);
		buf = buf.slice(nl + 1);
		if (!line.trim()) continue;
		let req;
		try {
			req = JSON.parse(line);
		} catch {
			log({ dir: "in", data: line, unparseable: true });
			continue;
		}
		log({ dir: "in", data: req });
		handle(req);
	}
});
// Pi shuts down when stdin closes (the app's orderly stop).
process.stdin.on("end", () => {
	log({ dir: "meta", stdinClosed: true });
	if (T.ignoreStdinEnd) return void setInterval(() => {}, 1000); // a stubborn program: it must be killed (transcript kill-stubborn)
	process.exit(0);
});
