"use strict";
// The switches for a person's real trial (src/trial.js): a separate data folder and a trial log, both only in an unpackaged app. The log holds
// counts, names, tool names and outcomes, never the key, file contents, commands or prompt text. Stand-in SDK only; no real key, no model.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { userDataOverride, trialLogFile, createTrialLog, safeName } = require("../src/trial");
const { createClaudeAdapter } = require("../src/agents/claude");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pc-trial-test-"));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const ABS = path.join(tmp, "data");
const KEY = "sk-ant-test-TRIALKEY-0123456789";

test("the data folder switch works only in an unpackaged app, and only with an absolute path", () => {
	assert.equal(userDataOverride({ isPackaged: false, env: { PI_CRUST_USERDATA: ABS } }), path.normalize(ABS));
	assert.equal(userDataOverride({ isPackaged: true, env: { PI_CRUST_USERDATA: ABS } }), null, "packaged: ignored");
	for (const bad of [undefined, "", "   ", "relative\\dir", "./x", "data", 5, null]) assert.equal(userDataOverride({ isPackaged: false, env: { PI_CRUST_USERDATA: bad } }), null, String(bad));
	assert.equal(userDataOverride({ isPackaged: false, env: {} }), null);
});

test("the trial log switch works only in an unpackaged app, and only with an absolute path", () => {
	const f = path.join(tmp, "trial.jsonl");
	assert.equal(trialLogFile({ isPackaged: false, env: { PI_CRUST_TRIAL_LOG: f } }), path.normalize(f));
	assert.equal(trialLogFile({ isPackaged: true, env: { PI_CRUST_TRIAL_LOG: f } }), null, "packaged: ignored");
	for (const bad of [undefined, "", "trial.log", "..\\x.log", 7]) assert.equal(trialLogFile({ isPackaged: false, env: { PI_CRUST_TRIAL_LOG: bad } }), null, String(bad));
	assert.equal(createTrialLog({ file: null }), null, "no file, no log");
});

test("main.js reads the data folder switch only through trial.js (which needs app.isPackaged) and skips the old-folder move for a trial", () => {
	const src = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
	assert.equal((src.match(/process.env.PI_CRUST_USERDATA/g) || []).length, 0, "main.js never reads the variable itself");
	assert.match(src, /userDataOverride\(\{ isPackaged: app\.isPackaged \}\)/);
	assert.match(src, /!trialData && !fs\.existsSync\(userData\)/);
	const setup = fs.readFileSync(path.join(__dirname, "..", "src", "claude-setup-main.js"), "utf8");
	assert.match(setup, /trialLogFile\(\{ isPackaged \}\)/);
	assert.match(setup, /selftest === true \? null/, "never in a self-test");
});

test("names the engine reports are kept only when plain and short, and never a key", () => {
	assert.equal(safeName("plugin:thing_1"), "plugin:thing_1");
	assert.equal(safeName("ANTHROPIC_API_KEY"), "ANTHROPIC_API_KEY");
	for (const bad of [KEY, "x".repeat(61), "a\nb", "C:\\Users\\x", "<script>", "", null, {}, 5]) assert.equal(safeName(bad), null, String(bad));
});

test("the chat id in a chat_start line is a number, or a name of letters, digits, - and _ only", () => {
	const f = path.join(tmp, "ids.jsonl");
	const log = createTrialLog({ file: f });
	const ids = [7, "chat-12_a", "a b", "C:\\secret\\folder", "x/y", "k" + KEY, { path: "C:\\private" }, ["a"], null, undefined, NaN, Infinity, true, "a.b", "é", "x".repeat(81)];
	for (const id of ids) log.chatStart(id, {}, "plan", false);
	const rows = fs.readFileSync(f, "utf8").trim().split(String.fromCharCode(10)).map((l) => JSON.parse(l));
	assert.deepEqual(rows.map((r) => r.chat ?? null), [7, "chat-12_a", ...Array(14).fill(null)]);
	assert.ok(!fs.readFileSync(f, "utf8").includes("secret"));
});

test("chat_start lines carry counts and names, and nothing else from the init message", () => {
	const f = path.join(tmp, "a.jsonl");
	const log = createTrialLog({ file: f, now: () => new Date("2026-01-01T00:00:00Z") });
	log.chatStart(1, {
		claude_code_version: "9.9.9",
		apiKeySource: "ANTHROPIC_API_KEY",
		permissionMode: "default",
		skills: ["pdf", "docx", KEY],
		plugins: [{ name: "p1", path: "C:\\secret\\folder" }],
		mcp_servers: [{ name: "srv", status: "connected" }, { name: "bad", status: "failed" }],
		agents: ["general-purpose", { name: "Explore", description: "never logged" }],
		cwd: "C:\\private\\project",
		tools: ["Read"],
		prompt: "never",
	}, "ask-commands", false);
	const lines = fs.readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l));
	assert.equal(lines.length, 1);
	const l = lines[0];
	assert.equal(l.ev, "chat_start");
	assert.equal(l.engineVersion, "9.9.9");
	assert.equal(l.keySource, "ANTHROPIC_API_KEY");
	assert.equal(l.enginePermissionMode, "default");
	assert.equal(l.appMode, "ask-commands");
	assert.deepEqual(l.skills, { count: 3, names: ["pdf", "docx"] });
	assert.deepEqual(l.plugins, { count: 1, names: ["p1"] });
	assert.deepEqual(l.mcpServers, { count: 2, names: ["srv", "bad"], status: ["connected", "failed"] });
	assert.deepEqual(l.agents, { count: 2, names: ["general-purpose", "Explore"] });
	const text = fs.readFileSync(f, "utf8");
	for (const never of [KEY, "C:\\\\secret", "C:\\\\private", "never"]) assert.ok(!text.includes(never), never);
});

test("gate lines: a hook deny is final; an ask waits for the outcome; names, answers and main loop or subagent only", () => {
	const f = path.join(tmp, "g.jsonl");
	const log = createTrialLog({ file: f });
	log.hook({ id: "t1", tool: "Bash", answer: "ask", sub: false });
	log.final({ id: "t1", tool: "Bash", outcome: "allow", prompted: true, sub: false });
	log.hook({ id: "t2", tool: "Write", answer: "deny", sub: true });
	log.hook({ id: "t3", tool: "Bash", answer: "ask", sub: true });
	log.final({ id: "t3", tool: "Bash", outcome: "deny", prompted: true, sub: true });
	log.final({ id: "zzz", tool: "Read", outcome: "allow", prompted: false, sub: false });
	const rows = fs.readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l));
	assert.deepEqual(rows.map(({ t, ...r }) => r), [
		{ ev: "gate", tool: "Bash", hook: "ask", outcome: "allow", prompted: true, by: "main" },
		{ ev: "gate", tool: "Write", hook: "deny", outcome: "deny", prompted: false, by: "subagent" },
		{ ev: "gate", tool: "Bash", hook: "ask", outcome: "deny", prompted: true, by: "subagent" },
		{ ev: "gate", tool: "Read", hook: "none", outcome: "allow", prompted: false, by: "main" },
	]);
});

test("a log that cannot be written never throws", () => {
	const log = createTrialLog({ file: path.join(tmp, "x.jsonl"), fsApi: { mkdirSync() { throw new Error("no"); }, appendFileSync() { throw new Error("no"); } } });
	log.chatStart(1, {}, "plan", false);
	log.hook({ id: "a", tool: "Bash", answer: "deny" });
	log.final({ id: "a", tool: "Bash", outcome: "deny" });
});

// End to end with the adapter and the stand-in SDK: the real hook and canUseTool feed the log.
test("an adapter chat writes one chat_start and one gate line per call, with no command text, file contents or key", async () => {
	const sdk = await import(pathToFileURL(path.join(__dirname, "claude-sdk-stand-in.mjs")).href);
	sdk.reset();
	const cwd = fs.mkdtempSync(path.join(tmp, "proj-"));
	const file = path.join(tmp, "e2e.jsonl");
	const adapter = createClaudeAdapter({
		enginePath: () => ({ path: "C:/stub/claude.exe" }),
		keystore: { read: async () => ({ source: "stored", key: KEY }), status: async () => ({ source: "stored" }), set: async () => ({ ok: true }), clear: async () => ({ ok: true }) },
		configDir: path.join(tmp, "cfg"),
		isPackaged: () => false,
		loadSdk: async () => sdk,
		killTree: () => {},
		getSettings: () => ({}),
		env: { OPENAI_API_KEY: "LEAKVALUE1", GH_TOKEN: "LEAKVALUE2", PATH: "p" },
	});
	adapter.configure({ trial: createTrialLog({ file }) });
	const SECRET_CMD = "npm run build --token=SECRETTEXT";
	sdk.setScript([
		{ type: "system", subtype: "init", session_id: "s1", model: "claude-haiku-5-5", permissionMode: "default", claude_code_version: "2.0.0", apiKeySource: "ANTHROPIC_API_KEY", skills: ["pdf"], plugins: [], mcp_servers: [], agents: ["Explore"] },
		{ __tool_call: { tool_name: "Bash", tool_input: { command: SECRET_CMD } } },
		{ __tool_call: { tool_name: "Bash", tool_input: { command: "npm run lint" }, agent_id: "agent-1" } },
		{ __tool_call: { tool_name: "Read", tool_input: { file_path: "<cwd>/notes.txt" } } },
		{ type: "result", subtype: "success", is_error: false, result: "ok", total_cost_usd: 0, session_id: "s1" },
	]);
	const ready = [];
	const sink = { isCurrent: () => true, ready: (h, d) => ready.push(d), record() {}, stderr() {}, exit() {}, ask: async (h, prompt) => (/lint/.test(prompt.title) ? "Deny" : "Allow once") };
	const h = adapter.start({ cwd, mode: "ask-commands", env: { OPENAI_API_KEY: "LEAKVALUE1", GH_TOKEN: "LEAKVALUE2", PATH: "p" } }, sink);
	const until = async (f, ms = 4000) => {
		const t = Date.now();
		while (!f()) {
			if (Date.now() - t > ms) throw new Error("timed out");
			await new Promise((r) => setTimeout(r, 5));
		}
	};
	await until(() => ready.length >= 1);
	adapter.send(h, { type: "prompt", message: "my private prompt text" });
	await until(() => fs.existsSync(file) && fs.readFileSync(file, "utf8").trim().split("\n").length >= 4);
	adapter.stop(h);
	const text = fs.readFileSync(file, "utf8");
	const rows = text.trim().split("\n").map((l) => JSON.parse(l)).map(({ t, ...r }) => r);
	assert.equal(rows[0].ev, "chat_start");
	assert.equal(rows[0].engineVersion, "2.0.0");
	assert.equal(rows[0].keySource, "ANTHROPIC_API_KEY");
	assert.equal(rows[0].appMode, "ask-commands");
	assert.equal(rows[0].envDropped, 2, "only the count of dropped secret-looking variables");
	assert.deepEqual(rows[0].skills, { count: 1, names: ["pdf"] });
	assert.deepEqual(rows[0].agents, { count: 1, names: ["Explore"] });
	assert.deepEqual(rows.slice(1).map((r) => [r.tool, r.hook, r.outcome, r.prompted, r.by]), [
		["Bash", "ask", "allow", true, "main"],
		["Bash", "ask", "deny", true, "subagent"],
		["Read", "ask", "allow", false, "main"],
	]);
	for (const never of [KEY, "LEAKVALUE", "OPENAI_API_KEY", "GH_TOKEN", "SECRETTEXT", "npm run", "private prompt", "notes.txt", cwd]) assert.ok(!text.includes(never), "not in the log: " + never);
});

test("chat_start is written once per chat start, not once per turn, and carries the tab's chat id", async () => {
	const sdk = await import(pathToFileURL(path.join(__dirname, "claude-sdk-stand-in.mjs")).href);
	sdk.reset();
	const cwd = fs.mkdtempSync(path.join(tmp, "proj-"));
	const file = path.join(tmp, "once.jsonl");
	const adapter = createClaudeAdapter({
		enginePath: () => ({ path: "C:/stub/claude.exe" }),
		keystore: { read: async () => ({ source: "stored", key: KEY }), status: async () => ({ source: "stored" }), set: async () => ({ ok: true }), clear: async () => ({ ok: true }) },
		configDir: path.join(tmp, "cfg2"),
		isPackaged: () => false,
		loadSdk: async () => sdk,
		killTree: () => {},
		getSettings: () => ({}),
		env: {},
	});
	adapter.configure({ trial: createTrialLog({ file }) });
	sdk.setScript([
		...[1, 2, 3].flatMap((i) => [
			{ type: "system", subtype: "init", session_id: "s1", model: "claude-haiku-5-5", permissionMode: "default", claude_code_version: "2.0.0", skills: [], plugins: [], mcp_servers: [], agents: [] },
			{ type: "result", subtype: "success", is_error: false, result: "ok", total_cost_usd: 0, session_id: "s1" },
			...(i < 3 ? [{ __await_user: true }] : []),
		]),
	]);
	let results = 0;
	const sink = { isCurrent: () => true, ready: () => {}, record: (h, r) => { if (r.type === "agent_end") results++; }, stderr() {}, exit() {}, ask: async () => "Allow once" };
	const h = adapter.start({ cwd, mode: "plan", chatId: "chat-77" }, sink);
	const until = async (f, ms = 4000) => {
		const t = Date.now();
		while (!f()) {
			if (Date.now() - t > ms) throw new Error("timed out");
			await new Promise((r) => setTimeout(r, 5));
		}
	};
	for (let i = 1; i <= 3; i++) {
		adapter.send(h, { type: "prompt", message: "turn " + i });
		await until(() => results >= i);
	}
	adapter.stop(h);
	const rows = fs.readFileSync(file, "utf8").trim().split(String.fromCharCode(10)).map((l) => JSON.parse(l));
	assert.equal(rows.filter((r) => r.ev === "chat_start").length, 1);
	assert.equal(rows[0].chat, "chat-77");
});
