"use strict";
// The agent's tool show_in_viewer (spec: Viewer tabs and project files, task 13), the decisions with no app: the argument rules with attack
// inputs (src/viewer-agent-logic.js), the permission rule in every mode for both agents (src/permission-logic.js decideShow, the Pi extension
// and the Claude Agent's gate), the tool as each agent defines it, the limit, the reuse and the rate (src/viewer-agent-main.js). The end to end
// proof, with the real tabs, is the selftest step viewer-agent.
// Deliberate breaks, each of which must make its group fail (run: VA_BREAK=<name> node --test scripts/viewer-agent.test.js):
//   agent-host   a web address on any host is accepted            (group "arguments")
//   agent-path   a path is not checked against the project        (group "arguments")
//   agent-perm   the permission rule lets every read-refused file through (group "permission")
//   agent-rate   the per-turn limit of new tabs is ignored          (group "rate")
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { pathToFileURL } = require("node:url");

const BREAK = process.env.VA_BREAK || "";
// The permission break: the shared logic is loaded from a copy of its source with one rule removed, and put where every require finds it.
if (BREAK === "agent-perm") {
	const file = require.resolve("../src/permission-logic");
	const src = fs.readFileSync(file, "utf8");
	const mutated = src.replace('if (read.action === "allow") return allow();', "return allow();");
	assert.notEqual(mutated, src, "the break must change the source");
	const m = new Module(file, module);
	m.filename = file;
	m.paths = Module._nodeModulePaths(path.dirname(file));
	m._compile(mutated, file);
	require.cache[file] = m;
}
const logic = require("../src/permission-logic");
const perms = require("../src/agents/claude/permissions");
const AL = require("../src/viewer-agent-logic");
const AM = require("../src/viewer-agent-main");
const T = require("../src/viewer-agent-target");
const VO = require("../src/viewer-open-logic");
const pp = require("../src/project-protocol");
const piTool = require("../src/pi-viewer-tool");
const viewerTool = require("../src/agents/claude/viewer-tool");
const { R } = AL;

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-crust-va-")));
const root = path.join(tmp, "project");
const outside = path.join(tmp, "outside");
const put = (base, rel, data = "x") => {
	fs.mkdirSync(path.dirname(path.join(base, rel)), { recursive: true });
	fs.writeFileSync(path.join(base, rel), data);
};
put(root, "index.html");
put(root, "docs/pricing.html");
put(root, "img/logo.svg");
put(root, "doc.pdf");
put(root, "notes.txt");
put(root, "src/app.js");
put(root, ".hidden/secret.html");
put(root, ".env");
put(outside, "secret.html");
let junction = true;
try { fs.symlinkSync(outside, path.join(root, "linkdir"), "junction"); } catch { junction = false; }
test.after(() => {
	try { fs.rmdirSync(path.join(root, "linkdir")); } catch { /* none */ }
	fs.rmSync(tmp, { recursive: true, force: true });
});

const al = AL.create({ breakMode: BREAK });
const bar = VO.create();

// --- arguments -----------------------------------------------------------------------------------------------------------------
test("arguments: what is accepted", () => {
	assert.deepEqual(al.check(root, "docs/pricing.html"), { file: { path: "docs/pricing.html", kind: "page" } });
	assert.deepEqual(al.check(root, "./docs/pricing.html"), { file: { path: "docs/pricing.html", kind: "page" } });
	assert.deepEqual(al.check(root, "docs\\pricing.html"), { file: { path: "docs/pricing.html", kind: "page" } });
	assert.deepEqual(al.check(root, path.join(root, "docs", "pricing.html")), { file: { path: "docs/pricing.html", kind: "page" } });
	assert.deepEqual(al.check(root, "img/logo.svg"), { file: { path: "img/logo.svg", kind: "image" } });
	assert.deepEqual(al.check(root, "doc.pdf"), { file: { path: "doc.pdf", kind: "pdf" } });
	assert.deepEqual(al.check(root, "http://localhost:3000"), { address: "http://localhost:3000/" });
	assert.deepEqual(al.check(root, "https://127.0.0.1:5173/app?x=1"), { address: "https://127.0.0.1:5173/app?x=1" });
	assert.deepEqual(al.check(root, "http://[::1]:8080/"), { address: "http://[::1]:8080/" });
	assert.deepEqual(al.check(root, "localhost:3000/x"), { address: "http://localhost:3000/x" });
	assert.deepEqual(al.check(root, "127.0.0.1:8000"), { address: "http://127.0.0.1:8000/" });
	assert.deepEqual(al.check(root, " HTTP://LOCALHOST:3000/A "), { address: "http://localhost:3000/A" });
});

test("arguments: every attack is refused, with the address bar's own words where the bar has them", () => {
	const unc = "\\\\server\\share\\a.html";
	const cases = [
		// outside the project
		["../outside/secret.html", R.outside],
		["docs/../../outside/secret.html", R.outside],
		["..\\outside\\secret.html", R.outside],
		[path.join(outside, "secret.html"), R.outside],
		[unc, R.outside],
		["//server/share/a.html", null],
		["C:\\Windows\\win.ini", null],
		["/etc/passwd", null],
		// schemes: a model never types an internal or a file address
		["file:///C:/Windows/win.ini", R.scheme],
		["file://server/share/a.html", R.scheme],
		[pp.toAddress(root, "index.html"), R.scheme], // this project's own internal address
		["pi-project://p-0000000000000000/index.html", R.scheme], // another project's
		["javascript:alert(1)", R.scheme],
		["data:text/html,<b>x</b>", R.scheme],
		["ftp://localhost/x", R.scheme],
		["ws://localhost:3000", R.scheme],
		["about:blank", R.scheme],
		// hosts that are not local
		["http://example.com/", R.host],
		["https://example.com:3000", R.host],
		["example.com", R.host],
		["http://localhost.evil.test:3000/", R.host],
		["http://localhost.evil.test", R.host],
		["http://evil.test/localhost", R.host],
		["http://localhost@evil.test/", R.host],
		["http://localhost:80@evil.test/", R.host],
		["http://user:pw@localhost:3000/", R.host],
		["http://127.0.0.1@evil.test/", R.host],
		["http://127.0.0.2:3000", R.host],
		["http://127.1.2.3/", R.host],
		["http://10.0.0.5/", R.host],
		["http://192.168.1.10:8080", R.host],
		["http://169.254.169.254/latest/meta-data", R.host],
		["http://0.0.0.0:3000", R.host],
		["http://[::2]/", R.host],
		["http://[::ffff:10.0.0.1]/", R.host],
		["http://localhost./", R.host],
		["http://127.0.0.1.evil.test/", R.host],
		// dot files and folders, kinds, folders, missing files
		[".env", R.dot],
		[".hidden/secret.html", R.dot],
		["docs/../.env", R.dot],
		["notes.txt", R.kind],
		["src/app.js", R.kind],
		["docs", R.folder],
		["nope.html", R.missing],
		// shapes
		["x".repeat(3000), R.invalid],
		[`${"a/".repeat(600)}x.html`, R.invalid],
		["docs/pricing.html\u0000", R.invalid],
		["docs/pricing\n.html", R.invalid],
		["http://localhost:3000/\u0007", R.invalid],
		["", R.arg],
		["   ", R.arg],
		[42, R.arg],
		[null, R.arg],
		[undefined, R.arg],
		[{ toString: () => "index.html" }, R.arg],
		[["index.html"], R.arg],
	];
	if (junction) cases.push(["linkdir/secret.html", R.outside]);
	for (const [input, reason] of cases) {
		const r = al.check(root, input);
		assert.ok(r.refuse, `refused: ${String(JSON.stringify(input)).slice(0, 80)}`);
		assert.ok(!r.file && !r.address);
		if (reason) assert.equal(r.refuse, reason, String(JSON.stringify(input)).slice(0, 80));
	}
	// An NTFS stream name never reaches the file behind it.
	assert.ok(al.check(root, "index.html::$DATA").refuse);
	assert.ok(al.check(root, "index.html:evil").refuse);
});

test("arguments: the same words as the address bar where the bar refuses the same text", () => {
	for (const t of [".env", "notes.txt", "docs", "../outside/secret.html", "file:///x"]) {
		const b = bar.checkTyped(root, t);
		assert.ok(b.refuse, t);
		assert.equal(al.check(root, t).refuse, b.refuse, t);
	}
});

test("arguments: no project, and a worktree chat", () => {
	assert.equal(al.check(null, "docs/pricing.html").refuse, R.noproject);
	assert.equal(al.check(root, "docs/pricing.html", { worktree: true }).refuse, R.worktree);
	assert.deepEqual(al.check(root, "http://localhost:3000/", { worktree: true }), { address: "http://localhost:3000/" }); // an address does not depend on the folder
	assert.deepEqual(al.check(null, "http://localhost:3000/"), { address: "http://localhost:3000/" });
});

test("arguments: parse tells the three kinds apart and bounds the text", () => {
	assert.equal(T.parse("docs/a.html").kind, "path");
	assert.equal(T.parse("C:\\p\\a.html").kind, "path"); // a drive letter is not a scheme
	assert.equal(T.parse("localhost:3000").kind, "address");
	assert.equal(T.parse("http://localhost:3000").local, true);
	assert.equal(T.parse("http://evil.test").local, false);
	assert.equal(T.parse("x".repeat(1025)).kind, "invalid");
	assert.equal(T.parse("x".repeat(1024)).kind, "path");
	assert.deepEqual([...T.LOCAL_HOSTS].sort(), ["127.0.0.1", "[::1]", "localhost"]);
});

// --- permission ----------------------------------------------------------------------------------------------------------------
const MODES = logic.MODE_IDS;
const FULL = viewerTool.FULL_NAME;
const piJudge = (mode, toolName, input) => logic.decide({ mode, toolName, input, cwd: root, grants: logic.createGrants() });
const claudeJudge = (mode, toolName, input) => perms.judge({ mode, toolName, input, grants: logic.createGrants(), cwd: root }).d;
const UNC = "\\\\server\\share\\a.html";

test("permission: a file the Viewer can show needs exactly what reading it needs; one it would refuse is never allowed, in every mode, for both agents", () => {
	const paths = ["docs/pricing.html", path.join(root, "img", "logo.svg"), "../outside/secret.html", path.join(outside, "secret.html"), ".env", UNC, "//host/share/x.png", "file://host/share/x.png", "notes.txt", "x".repeat(2000)];
	for (const mode of MODES) {
		for (const p of paths) {
			const read = piJudge(mode, "read", { path: p });
			const showPi = piJudge(mode, "show_in_viewer", { target: p });
			const showClaude = claudeJudge(mode, FULL, { target: p });
			const readClaude = claudeJudge(mode, "Read", { file_path: p });
			const mainOk = !al.check(root, p).refuse; // what the main side accepts
				assert.equal(showPi.action === "allow", mainOk && read.action === "allow", `Pi ${mode} ${p.slice(0, 40)}`);
			assert.equal(showClaude.action === "allow", mainOk && readClaude.action === "allow", `Claude ${mode} ${p.slice(0, 40)}`);
			assert.notEqual(showPi.action, "ask", "never a question of its own (Pi)");
			assert.notEqual(showClaude.action, "ask", "never a question of its own (Claude)");
			if (showPi.action === "block") assert.ok(/same permission as reading/.test(showPi.reason) || Object.values(R).includes(showPi.reason), showPi.reason); // the permission reason, or the Viewer's own sentence
		}
	}
});

test("permission: a localhost address is allowed in every mode; a network path is refused in every mode (the Viewer never shows one)", () => {
	for (const mode of MODES) {
		for (const a of ["http://localhost:3000", "https://127.0.0.1:5173/x", "http://[::1]:8080", "localhost:3000"]) {
			assert.equal(piJudge(mode, "show_in_viewer", { target: a }).action, "allow", `Pi ${mode} ${a}`);
			assert.equal(claudeJudge(mode, FULL, { target: a }).action, "allow", `Claude ${mode} ${a}`);
		}
		assert.equal(piJudge(mode, "show_in_viewer", { target: UNC }).action, "block", `Pi UNC ${mode}`);
		assert.equal(claudeJudge(mode, FULL, { target: UNC }).action, "block", `Claude UNC ${mode}`);
		// A call with no readable target is blocked with a reason, never asked.
		for (const bad of [{}, { target: "" }, { target: 5 }, { path: "docs/a.html" }]) assert.equal(piJudge(mode, "show_in_viewer", bad).action, "block", JSON.stringify(bad));
	}
});

test("permission: the Claude Agent's table classifies the tool explicitly and nothing else comes with it", () => {
	assert.equal(perms.TOOL_TABLE[FULL], "show_in_viewer");
	assert.equal(FULL, "mcp__pi-crust__show_in_viewer");
	assert.deepEqual(Object.keys(perms.TOOL_TABLE).filter((k) => /show_in_viewer/.test(k)), [FULL]);
	for (const mode of MODES) {
		// the same tool name from anywhere else is an unknown tool: it asks (or is blocked in Plan), as any unknown tool
		for (const n of ["show_in_viewer", "mcp__other__show_in_viewer", "mcp__pi-crust__other", "mcp__pi-crust__show_in_viewer2"]) {
			const d = claudeJudge(mode, n, { target: "docs/pricing.html" });
			assert.equal(d.action, mode === "trusted" ? "allow" : mode === "plan" ? "block" : "ask", `${n} ${mode}`);
		}
	}
});

test("permission: Claude Agent end to end, the PreToolUse hook then canUseTool, like every other tool", async () => {
	for (const mode of MODES) {
		const asked = [];
		const cuo = perms.makeCanUseTool({ getMode: () => mode, ask: (p) => (asked.push(p), "Allow once"), cwd: root });
		const hook = perms.makePreToolUseHook({ getMode: () => mode, grants: cuo.grants, cwd: root });
		for (const [target, allowed] of [["docs/pricing.html", true], ["http://localhost:3000", true], [UNC, false]]) {
			const input = { target };
			const h = await hook({ hook_event_name: "PreToolUse", tool_name: FULL, tool_input: input, tool_use_id: "t1" });
			const decision = h.hookSpecificOutput.permissionDecision;
			assert.equal(decision, allowed ? "ask" : "deny", `hook ${mode} ${target}`); // the hook never allows by itself: "ask" sends the call on to canUseTool
			if (decision === "deny") assert.equal(h.hookSpecificOutput.permissionDecisionReason, R.outside); // the Viewer's own sentence
			if (decision === "ask") {
				const r = await cuo(FULL, input, { signal: new AbortController().signal, toolUseID: "t1" });
				assert.equal(r.behavior, "allow", `canUseTool ${mode} ${target}`);
				assert.deepEqual(r.updatedInput, input);
			}
		}
		assert.deepEqual(asked, [], `${mode}: nobody was asked`);
	}
});

test("permission: the Pi extension pins the argument the decision read", () => {
	assert.deepEqual(logic.pinKeys("show_in_viewer"), ["target"]);
	assert.equal(logic.classify("show_in_viewer"), "safe");
});

// --- the tool, as each agent defines it ---------------------------------------------------------------------------------------------
test("Pi: the tool is one plain schema with one argument, and it only asks the app", async () => {
	const tool = piTool.createTool();
	assert.equal(tool.name, "show_in_viewer");
	assert.deepEqual(tool.parameters.required, ["target"]);
	assert.deepEqual(Object.keys(tool.parameters.properties), ["target"]);
	assert.equal(tool.parameters.additionalProperties, false);
	const registered = [];
	assert.equal(piTool.register({ registerTool: (t) => registered.push(t) }), true);
	assert.deepEqual(registered.map((t) => t.name), ["show_in_viewer"]);
	assert.equal(piTool.register({}), false); // an old Pi without registerTool: no tool, no error
	const seen = [];
	const ctx = (answer) => ({ mode: "rpc", hasUI: true, ui: { input: async (title, placeholder, opts) => (seen.push([title, placeholder, !!opts.signal, opts.timeout]), typeof answer === "function" ? answer(placeholder) : answer), select: async () => assert.fail("never asks the person"), confirm: async () => assert.fail("never asks the person") } });
	const ok = await tool.execute("c1", { target: "docs/pricing.html" }, new AbortController().signal, null, ctx(JSON.stringify({ ok: true, text: "Shown." })));
	assert.deepEqual(ok.content, [{ type: "text", text: "Shown." }]);
	assert.deepEqual(seen[0].slice(0, 3), [piTool.TITLE, "docs/pricing.html", true]);
	assert.ok(seen[0][3] > 0);
	await assert.rejects(tool.execute("c2", { target: "x" }, null, null, ctx(JSON.stringify({ ok: false, text: R.outside }))), (e) => e.message === R.outside);
	for (const bad of [undefined, "", "not json", "{}", JSON.stringify({ ok: "yes", text: "x" })]) await assert.rejects(tool.execute("c3", { target: "x" }, null, null, ctx(bad)), /did not answer/);
	await assert.rejects(tool.execute("c4", { target: "x" }, null, null, { mode: "tui", hasUI: true, ui: {} }), /only be reached from a chat in Pi Crust/);
	await assert.rejects(tool.execute("c5", { target: "x" }, null, null, { mode: "rpc", hasUI: true, ui: { input: async () => { throw new Error("boom"); } } }), /did not answer/);
	const long = "x".repeat(5000);
	await tool.execute("c6", { target: long }, null, null, ctx((p) => (assert.ok(p.length <= 2000), JSON.stringify({ ok: true, text: "ok" }))));
});

test("Pi: the schema passes Pi's own validator when Pi is installed here", async (t) => {
	const dirs = [process.env.PI_CRUST_PI_DIR, process.env.APPDATA && path.join(process.env.APPDATA, "npm", "node_modules", "@earendil-works", "pi-coding-agent")].filter(Boolean);
	const dir = dirs.find((d) => fs.existsSync(path.join(d, "node_modules", "@earendil-works", "pi-ai", "dist", "utils", "validation.js")));
	if (!dir) return t.skip("Pi is not installed here");
	const v = await import(pathToFileURL(path.join(dir, "node_modules", "@earendil-works", "pi-ai", "dist", "utils", "validation.js")).href);
	const tool = piTool.createTool();
	const call = { name: "show_in_viewer", arguments: { target: "docs/pricing.html" } };
	assert.deepEqual(v.validateToolArguments(tool, call), { target: "docs/pricing.html" });
	assert.throws(() => v.validateToolArguments(tool, { name: "show_in_viewer", arguments: {} }));
});

const standInUrl = pathToFileURL(path.join(__dirname, "claude-sdk-stand-in.mjs")).href;
test("Claude Agent: one host-defined tool, in-process, and nothing else comes with it", async () => {
	const sdk = await import(standInUrl);
	const shown = [];
	const zod = require("zod");
	const server = viewerTool.build({ sdk, zod, show: async (chatId, target) => (shown.push([chatId, target]), { ok: true, text: "Shown." }), chatId: "chat-1", getMode: () => "plan", getCwd: () => root });
	assert.equal(server.type, "sdk");
	assert.equal(server.name, "pi-crust");
	assert.deepEqual(server.instance.tools.map((x) => x.name), ["show_in_viewer"]);
	const def = server.instance.tools[0];
	assert.deepEqual(Object.keys(def.inputSchema), ["target"]);
	// the handler refuses what the gate would, and runs what it allows
	assert.deepEqual(await def.handler({ target: "docs/pricing.html" }), { content: [{ type: "text", text: "Shown." }] });
	const refused = await def.handler({ target: UNC });
	assert.equal(refused.isError, true);
	assert.equal(refused.content[0].text, R.outside);
	const failed = await viewerTool.build({ sdk, zod, show: async () => ({ ok: false, text: R.outside }), chatId: "c", getMode: () => "plan", getCwd: () => root }).instance.tools[0].handler({ target: "docs/other.html" });
	assert.deepEqual(failed, { content: [{ type: "text", text: R.outside }], isError: true });
	assert.deepEqual(shown, [["chat-1", "docs/pricing.html"]]);
	// no SDK support, no zod, no app side: no tool at all
	assert.equal(viewerTool.build({ sdk: {}, zod, show() {}, chatId: "c", getMode: () => "plan", getCwd: () => root }), null);
	assert.equal(viewerTool.build({ sdk, zod: null, show() {}, chatId: "c", getMode: () => "plan", getCwd: () => root }), null);
	assert.equal(viewerTool.build({ sdk, zod, show: null, chatId: "c", getMode: () => "plan", getCwd: () => root }), null);
});

test("Claude Agent: the adapter hands the SDK that one server, and the call goes through the real gate", async () => {
	const { createClaudeAdapter } = require("../src/agents/claude");
	const sdk = await import(standInUrl);
	sdk.reset();
	const cwd = fs.mkdtempSync(path.join(tmp, "chat-"));
	const ks = { read: async () => ({ source: "stored", key: "k-test-not-real" }), status: async () => ({ source: "stored" }), set: async () => ({}), clear: async () => ({}) };
	const shown = [];
	const ad = createClaudeAdapter({ enginePath: () => ({ path: "C:/stub/claude.exe" }), keystore: ks, configDir: path.join(tmp, "cfg"), isPackaged: () => false, loadSdk: async () => sdk, killTree: () => {}, getSettings: () => ({}), env: {}, showInViewer: async (chatId, target) => (shown.push([chatId, target]), { ok: true, text: "Shown " + target }) });
	const ready = [];
	const asked = [];
	const sink = { isCurrent: () => true, ready: (h, d) => ready.push(d), record: () => {}, stderr: () => {}, exit: () => {}, ask: async (h, prompt) => (asked.push(prompt.title), "Allow once") };
	const call = (tool_name, target) => ({ __tool_call: { tool_name, tool_input: { target } } });
	sdk.setScript([
		{ type: "system", subtype: "init", session_id: "s" },
		call(FULL, "docs/pricing.html"),
		call(FULL, "http://localhost:3000"),
		call(FULL, UNC),
		call("mcp__other__show_in_viewer", "docs/pricing.html"),
		{ type: "result", subtype: "success", is_error: false, result: "ok", total_cost_usd: 0, session_id: "s" },
	]);
	const h = ad.start({ cwd, mode: "plan", chatId: "chat-7" }, sink);
	for (let i = 0; i < 400 && !ready.length; i++) await new Promise((r) => setTimeout(r, 5));
	const c = sdk.calls[0];
	assert.deepEqual(c.options.mcpServers, { "pi-crust": { type: "sdk", tools: ["show_in_viewer"] } });
	assert.deepEqual(Object.keys(c.options.mcpServers), ["pi-crust"]);
	assert.ok(ad.send(h, { type: "prompt", message: "go" }));
	for (let i = 0; i < 400 && c.gates.length < 4; i++) await new Promise((r) => setTimeout(r, 5));
	assert.deepEqual(c.gates.map((g) => [g.call.tool_name, g.hooks[0], g.outcome]), [[FULL, "ask", "allow"], [FULL, "ask", "allow"], [FULL, "deny", "deny"], ["mcp__other__show_in_viewer", "deny", "deny"]]);
	assert.equal(c.gates[0].toolResult.content[0].text, "Shown docs/pricing.html");
	assert.equal(c.gates[1].toolResult.content[0].text, "Shown http://localhost:3000");
	assert.deepEqual(shown, [["chat-7", "docs/pricing.html"], ["chat-7", "http://localhost:3000"]]);
	assert.deepEqual(asked, [], "Plan asks nobody");
	ad.stop(h);
	// An adapter with no app side has no such tool.
	const bare = createClaudeAdapter({ enginePath: () => ({ path: "C:/stub/claude.exe" }), keystore: ks, configDir: path.join(tmp, "cfg"), isPackaged: () => false, loadSdk: async () => sdk, killTree: () => {}, getSettings: () => ({}), env: {} });
	sdk.reset();
	const ready2 = [];
	const h2 = bare.start({ cwd, mode: "plan" }, { ...sink, ready: (x, d) => ready2.push(d) });
	for (let i = 0; i < 400 && !ready2.length; i++) await new Promise((r) => setTimeout(r, 5));
	assert.equal(sdk.calls[0].options.mcpServers, undefined);
	bare.stop(h2);
});

test("Claude Agent: no other host tool exists in the code", () => {
	const dir = path.join(__dirname, "..", "src");
	const hits = [];
	const walk = (d) => {
		for (const e of fs.readdirSync(d, { withFileTypes: true })) {
			const f = path.join(d, e.name);
			if (e.isDirectory()) walk(f);
			else if (/\.(js|mjs|ts)$/.test(e.name) && !/\.test\./.test(e.name)) {
				const t = fs.readFileSync(f, "utf8");
				if (/createSdkMcpServer\(|\bsdk\.tool\(/.test(t)) hits.push(path.relative(dir, f).replace(/\\/g, "/"));
			}
		}
	};
	walk(dir);
	assert.deepEqual(hits, ["agents/claude/viewer-tool.js"]);
	const src = fs.readFileSync(path.join(dir, "agents", "claude", "viewer-tool.js"), "utf8");
	assert.equal((src.match(/sdk\.tool\(/g) || []).length, 1);
});

// --- the app side: limit, reuse, rate, worktree --------------------------------------------------------------------------------------
// A stand-in for the Viewer's tabs with the real rules of openBackground: reuse by address, the limit of 8, `allowNew`.
function fakeTabs(max = 8) {
	const tabs = [];
	return {
		tabs,
		activateShowing: async (a) => (tabs.includes(a) ? { ok: true, tabId: "t" + tabs.indexOf(a) } : { ok: false }),
		openBackground: async (address, { allowNew = true } = {}) => {
			if (tabs.includes(address)) return { ok: true, tabId: "t" + tabs.indexOf(address), reused: true, active: false };
			if (!allowNew) return { ok: false, reason: "rate" };
			if (tabs.length >= max) return { ok: false, reason: "limit", message: R.limit };
			tabs.push(address);
			return { ok: true, tabId: "t" + (tabs.length - 1), reused: false, active: false };
		},
	};
}
function app({ cwd = null, rootDir = root, tabs = fakeTabs() } = {}) {
	const sent = [];
	const a = AM.create({ getRoot: () => rootDir, viewerTabs: tabs, chatInfo: (id) => (id === "gone" ? null : { cwd }), send: (ch, p) => sent.push([ch, p]), protocol: pp, selftest: true, breakMode: BREAK });
	return { a, tabs, sent };
}

test("limit: at 8 pages the call is refused with the Viewer's own sentence, and nothing opens", async () => {
	const { a, tabs } = app();
	for (let i = 1; i <= 8; i++) tabs.tabs.push(`http://localhost:${3000 + i}/`);
	const r = await a.show("c", "docs/pricing.html");
	assert.deepEqual(r, { ok: false, text: "8 pages is the most. Close one first." });
	assert.equal(tabs.tabs.length, 8);
	// a page that is already open is still reachable at the limit
	const again = await a.show("c", "http://localhost:3001");
	assert.equal(again.ok, true);
	assert.equal(again.reused, true);
});

test("reuse: the same file or address again reuses its tab and marks it, it does not open a second one", async () => {
	const { a, tabs, sent } = app();
	const r1 = await a.show("c", "docs/pricing.html");
	const r2 = await a.show("c", "./docs/../docs/pricing.html");
	const r3 = await a.show("c", path.join(root, "docs", "pricing.html"));
	assert.deepEqual([r1.ok, r2.ok, r3.ok, r1.reused, r2.reused, r3.reused], [true, true, true, false, true, true]);
	assert.equal(tabs.tabs.length, 1);
	assert.equal(r1.tabId, r2.tabId);
	assert.match(r1.text, /docs\/pricing\.html/); // the result names the file
	assert.match(r1.text, /new background tab/);
	assert.match(r2.text, /marked as updated/);
	await a.show("c", "http://localhost:3000");
	await a.show("c", "localhost:3000/");
	assert.equal(tabs.tabs.length, 2);
	assert.deepEqual(sent.map(([ch, p]) => [ch, p.label, p.reused]), [["browser:agentShown", "docs/pricing.html", false], ["browser:agentShown", "docs/pricing.html", true], ["browser:agentShown", "docs/pricing.html", true], ["browser:agentShown", "http://localhost:3000/", false], ["browser:agentShown", "http://localhost:3000/", true]]);
});

test("rate: at most three new tabs per turn and chat; reused pages do not count; a new turn starts again", async () => {
	const { a, tabs } = app();
	const files = ["index.html", "docs/pricing.html", "img/logo.svg", "doc.pdf"];
	const out = [];
	for (const f of files) out.push(await a.show("c", f));
	assert.deepEqual(out.map((r) => r.ok), [true, true, true, false]);
	assert.equal(out[3].text, R.rate);
	assert.equal(tabs.tabs.length, 3);
	assert.equal((await a.show("c", "index.html")).ok, true); // reuse is free
	assert.equal((await a.show("other-chat", "doc.pdf")).ok, true); // another chat has its own count
	a.turnStarted("c");
	assert.equal((await a.show("c", "doc.pdf")).reused, true);
	put(root, "extra.html");
	assert.equal((await a.show("c", "extra.html")).ok, true);
	assert.equal(a.opened("c"), 1);
});

test("a chat in a worktree: files are refused, a localhost address is not; an unknown chat is refused", async () => {
	const wt = path.join(tmp, "project-worktree");
	const w = app({ cwd: wt });
	const f = await w.a.show("c", "docs/pricing.html");
	assert.deepEqual(f, { ok: false, text: R.worktree });
	assert.equal((await w.a.show("c", path.join(root, "docs", "pricing.html"))).ok, false);
	assert.equal((await w.a.show("c", "http://localhost:3000")).ok, true);
	assert.equal(w.tabs.tabs.length, 1);
	// a chat whose working folder IS the open project shows its files
	const same = app({ cwd: root });
	assert.equal((await same.a.show("c", "docs/pricing.html")).ok, true);
	assert.equal((await same.a.show("gone", "docs/pricing.html")).text, R.notrunning);
	// a refusal opens nothing and sends nothing to the UI
	const r = app();
	assert.equal((await r.a.show("c", "../outside/secret.html")).ok, false);
	assert.equal((await r.a.show("c", "http://example.com")).text, R.host);
	assert.deepEqual([r.tabs.tabs.length, r.sent.length], [0, 0]);
});

test("the tool card's click only reaches a tab that is open", async () => {
	const { a } = app();
	await a.show("c", "docs/pricing.html");
	assert.deepEqual(await a.focus("docs/pricing.html"), { ok: true, tabId: "t0" });
	assert.equal((await a.focus("index.html")).ok, false);
	assert.equal((await a.focus("../outside/secret.html")).message, R.outside);
});

test("the tool card's visible line says what happened (P2)", async () => {
	const ALine = require("../src/viewer-agent-line");
	const tabs = [];
	const vt = {
		openBackground: async (address) => {
			const same = tabs.includes(address);
			if (!same) tabs.push(address);
			return { ok: true, tabId: "t" + tabs.indexOf(address), reused: same, active: false };
		},
	};
	const am = AM.create({ getRoot: () => root, viewerTabs: vt, chatInfo: () => ({ cwd: root }), send: () => {}, protocol: pp });
	const a = await am.show("c1", "docs/pricing.html");
	const b = await am.show("c1", "docs/pricing.html");
	const c = await am.show("c1", "../outside/secret.html");
	assert.equal(ALine.line(a.text, !a.ok), "Opened docs/pricing.html in the Viewer");
	assert.equal(ALine.line(b.text, !b.ok), "Already open: docs/pricing.html");
	assert.equal(ALine.line(c.text, !c.ok), `Not shown: ${R.outside}`);
	// a failure from the agent's own gate or a thrown error is a failure too, with its first line as the reason
	assert.equal(ALine.line("Showing a file in the Viewer needs the same permission as reading it.\nMore.", true), "Not shown: Showing a file in the Viewer needs the same permission as reading it.");
	assert.equal(ALine.line("", true), "Not shown: the call failed.");
	assert.equal(ALine.line("something else", false), ""); // not ours: the card keeps its own summary
});

// --- S4 ------------------------------------------------------------------------------------------------------------------------
test("S4: the app's own Remote port is refused, by the main-side check, whatever the spelling", async () => {
	const a = AL.create({ remotePorts: () => [7391, 8123] });
	for (const t of ["http://localhost:7391/", "https://127.0.0.1:7391/x", "http://[::1]:8123/", "localhost:7391", "127.0.0.1:8123/a", "HTTP://LOCALHOST:7391"]) {
		assert.deepEqual(a.check(root, t), { refuse: R.remote }, t);
	}
	// every other port, and the same port on no list, is as before
	assert.deepEqual(a.check(root, "http://localhost:7392/"), { address: "http://localhost:7392/" });
	assert.deepEqual(al.check(root, "http://localhost:7391/"), { address: "http://localhost:7391/" });
	// through the app side too: nothing opens
	const tabs = [];
	const am = AM.create({ getRoot: () => root, viewerTabs: { openBackground: async (x) => (tabs.push(x), { ok: true, tabId: "t", reused: false, active: false }) }, chatInfo: () => ({ cwd: root }), send: () => {}, protocol: pp, remotePorts: () => [7391] });
	const r = await am.show("c", "http://localhost:7391/");
	assert.deepEqual(r, { ok: false, text: R.remote });
	assert.deepEqual(tabs, []);
});

test("S4: only exactly a loopback host is local", () => {
	for (const t of ["http://127.0.0.2/", "http://0.0.0.0/", "http://[::ffff:127.0.0.1]/", "http://[::]/", "http://localhost./", "http://localhost.evil.test/", "http://127.0.0.1.evil.test/", "http://user@localhost/", "http://localhost:pw@evil.test/", "http://192.168.1.2/", "http://10.0.0.1:3000/"]) {
		assert.deepEqual(al.check(root, t), { refuse: R.host }, t);
	}
	for (const t of ["http://0x7f.1/", "http://2130706433/", "http://127.1/"]) assert.equal(al.check(root, t).address, "http://127.0.0.1/", t); // the URL parser's own reading: it IS 127.0.0.1
});

test("S4: the permission rule does not allow what the main side refuses, in every mode, for both agents", () => {
	const refused = ["../x", "..\\x.html", "docs/../../outside/secret.html", ".env", ".git/config", "docs/.hidden/a.html", "./.hidden/secret.html", path.join(outside, "secret.html"), "http://example.com/", "http://localhost@evil.test/", "https://127.0.0.2/", "file:///C:/Windows/win.ini", "ftp://localhost/x", "notes.txt", "src/app.js", "//host/share/x.png", UNC, "javascript:alert(1)"];
	for (const mode of MODES) {
		for (const t of refused) {
			assert.equal(piJudge(mode, "show_in_viewer", { target: t }).action, "block", `Pi ${mode} ${t}`);
			assert.equal(claudeJudge(mode, FULL, { target: t }).action, "block", `Claude ${mode} ${t}`);
			assert.ok(al.check(root, t).refuse, `main refuses ${t}`);
		}
	}
});

test("S4: whatever the rule allows, the main side accepts (the two never disagree)", () => {
	const targets = ["docs/pricing.html", "./docs/../docs/pricing.html", "docs\\pricing.html", path.join(root, "img", "logo.svg"), "doc.pdf", "http://localhost:3000", "localhost:3000/x", "[::1]:8080", "http://127.0.0.1:5173/"];
	for (const mode of MODES) {
		for (const t of targets) {
			assert.equal(piJudge(mode, "show_in_viewer", { target: t }).action, "allow", `Pi ${mode} ${t}`);
			assert.equal(claudeJudge(mode, FULL, { target: t }).action, "allow", `Claude ${mode} ${t}`);
			assert.equal(al.check(root, t).refuse, undefined, `main ${t}`);
		}
	}
});

test("S4: Remote publishes its ports for the Viewer's agent tool (in the self-test too: the default port)", () => {
	const ctx = { selftest: true, ipcMain: { handle() {} } };
	require("../src/remote-main").register(ctx);
	assert.deepEqual(ctx.remotePorts(), [7391]);
	const src = fs.readFileSync(path.join(__dirname, "..", "src", "remote-main.js"), "utf8");
	assert.match(src, /ctx\.remotePorts = \(\) => \[cfg\.port, boundPort\]/, "the real server reports the configured and the bound port");
	assert.match(fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8"), /remotePorts: \(\) => \(ctx\.remotePorts \? ctx\.remotePorts\(\) : \[\]\)/, "main.js hands them to the agent tool");
});
