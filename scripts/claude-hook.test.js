"use strict";
// Claude agent gate in a PreToolUse hook (phase 7, T3 capture section 9). The stand-in SDK calls the hook first and canUseTool only when the
// hook says "ask", like the real one. No Electron, no real SDK, no key, no request to any model.
// HOOK_MUTATION=allow | skip-agent | trust-mode runs the same tests against a broken hook (the negative controls: they must fail).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");
const logic = require("../src/permission-logic");
const perms = require("../src/agents/claude/permissions");

const standIn = () => import(pathToFileURL(path.join(__dirname, "claude-sdk-stand-in.mjs")).href);
const FIXTURE = require("./claude-fixtures/hook-gate-calls.json");

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "claude-hook-")));
const proj = path.join(tmp, "proj");
const outside = path.join(tmp, "outside");
fs.mkdirSync(path.join(proj, "src"), { recursive: true });
fs.mkdirSync(outside);
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const inP = (f) => path.join(proj, f);
const outP = (f) => path.join(outside, f);

// The hook under test, possibly mutated.
const SDK_TO_MODE = { default: "ask-edits", plan: "plan", bypassPermissions: "trusted", acceptEdits: "ask-commands" };
function mkHook(opts) {
	const real = perms.makePreToolUseHook(opts);
	switch (process.env.HOOK_MUTATION) {
		case "allow":
			return async (input) => {
				const r = await real(input);
				return r.hookSpecificOutput.permissionDecision === "ask" ? { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } } : r;
			};
		case "skip-agent":
			return async (input) => (input && (input.tool_name === "Agent" || input.tool_name === "Task") ? {} : real(input));
		case "trust-mode":
			return async (input) => perms.makePreToolUseHook({ ...opts, getMode: () => (input && SDK_TO_MODE[input.permission_mode]) || input.permission_mode })(input);
		default:
			return real;
	}
}

// One chat: the options the adapter would hand the SDK (hooks + canUseTool), a scripted asker, the stand-in's gate.
function rig(mode, answer = "undefined") {
	const asked = [];
	const grants = logic.createGrants();
	const ask = async (prompt, meta) => {
		asked.push({ prompt, meta });
		return answer === "undefined" ? undefined : answer;
	};
	const canUseTool = perms.makeCanUseTool({ getMode: () => mode, ask, grants, cwd: proj });
	const hookOpts = { getMode: () => mode, grants, cwd: proj };
	const options = { cwd: proj, canUseTool, hooks: { PreToolUse: [{ hooks: [mkHook(hookOpts)], onFailure: "block" }] } };
	return { options, asked, hookOpts, grants };
}
async function gate(options, call) {
	const { runGate } = await standIn();
	return runGate(options, call);
}
const hookIn = (tool_name, tool_input, extra = {}) => ({ session_id: "s", transcript_path: "", cwd: proj, hook_event_name: "PreToolUse", tool_name, tool_input, tool_use_id: "toolu_x", permission_mode: "default", ...extra });
const answerOf = (r) => r && r.hookSpecificOutput && r.hookSpecificOutput.permissionDecision;

// --- the table: every tool x every mode, as the pair (hook answer, final outcome) --------------------------------
const MODES = logic.MODE_IDS;
// Inputs per tool (inside the project; Bash read-only so that it is allowed). Expected, per mode: [hook answer, final outcome].
// final "deny" after "ask" means nobody answered. The hook never answers "allow": it asks or denies.
const SAFE_IN_ALL = { plan: ["ask", "allow"], "ask-edits": ["ask", "allow"], "ask-commands": ["ask", "allow"], trusted: ["ask", "allow"] };
const EDIT_IN = { plan: ["deny", "deny"], "ask-edits": ["ask", "deny"], "ask-commands": ["ask", "allow"], trusted: ["ask", "allow"] };
const ASK_ALL = { plan: ["deny", "deny"], "ask-edits": ["ask", "deny"], "ask-commands": ["ask", "deny"], trusted: ["ask", "allow"] };
const INPUTS = {
	Read: [{ file_path: inP("src/a.js") }, SAFE_IN_ALL],
	NotebookRead: [{ notebook_path: inP("n.ipynb") }, SAFE_IN_ALL],
	Grep: [{ pattern: "x", path: inP("src") }, SAFE_IN_ALL],
	Glob: [{ pattern: "*.js" }, SAFE_IN_ALL],
	LS: [{ path: inP("src") }, SAFE_IN_ALL],
	TodoWrite: [{ todos: [] }, SAFE_IN_ALL],
	ToolSearch: [{ query: "select:Read" }, SAFE_IN_ALL],
	AskUserQuestion: [{ questions: [] }, SAFE_IN_ALL],
	TaskCreate: [{ subject: "s" }, SAFE_IN_ALL],
	TaskGet: [{ taskId: "1" }, SAFE_IN_ALL],
	TaskUpdate: [{ taskId: "1" }, SAFE_IN_ALL],
	TaskList: [{}, SAFE_IN_ALL],
	EnterPlanMode: [{}, SAFE_IN_ALL],
	Edit: [{ file_path: inP("src/a.js"), old_string: "a", new_string: "b" }, EDIT_IN],
	MultiEdit: [{ file_path: inP("src/a.js"), edits: [] }, EDIT_IN],
	Write: [{ file_path: inP("src/new.js"), content: "x" }, EDIT_IN],
	NotebookEdit: [{ notebook_path: inP("n.ipynb"), new_source: "x" }, EDIT_IN],
	Bash: [{ command: "rg TODO src" }, SAFE_IN_ALL],
	PowerShell: [{ command: "Remove-Item x" }, ASK_ALL],
	Task: [{ description: "d", prompt: "do it", subagent_type: "general-purpose" }, ASK_ALL],
	Agent: [{ description: "d", prompt: "do it", subagent_type: "general-purpose" }, ASK_ALL],
};
// Every other tool of the table asks in every mode and is blocked in Plan.
for (const name of Object.keys(perms.TOOL_TABLE)) if (!INPUTS[name]) INPUTS[name] = [{ x: 1 }, ASK_ALL];
INPUTS.SomethingNew = [{ x: 1 }, ASK_ALL];
INPUTS.mcp__srv__do = [{ a: 1 }, ASK_ALL];

test("the table covers every tool of the name table, plus an unknown one and an MCP one", () => {
	for (const name of Object.keys(perms.TOOL_TABLE)) assert.ok(INPUTS[name], name);
	assert.ok(Object.keys(INPUTS).length >= Object.keys(perms.TOOL_TABLE).length + 2);
});
for (const [name, [input, want]] of Object.entries(INPUTS)) {
	for (const mode of MODES) {
		const [wantHook, wantFinal] = want[mode];
		test(`pair: ${name} in ${mode} -> hook ${wantHook}, outcome ${wantFinal}`, async () => {
			const { options } = rig(mode);
			const g = await gate(options, { tool_name: name, tool_input: input });
			assert.deepEqual(g.hooks, [wantHook]);
			assert.equal(g.outcome, wantFinal);
			assert.equal(g.viaCanUseTool, wantHook === "ask", "canUseTool is reached exactly when the hook asked");
			assert.equal(g.sdkAuto, undefined, "the SDK approves nothing by itself");
		});
	}
}

// --- what the capture found: the Agent tool and an inside Read now reach the decision --------------------------
test("without the hook the SDK approves the Agent tool and an inside Read by itself; with the hook both reach canUseTool", async () => {
	const calls = [
		{ tool_name: "Agent", tool_input: { description: "d", prompt: "p" } },
		{ tool_name: "Read", tool_input: { file_path: inP("src/a.js") } },
	];
	const bare = rig("ask-edits");
	for (const c of calls) {
		const g = await gate({ ...bare.options, hooks: undefined }, c);
		assert.equal(g.sdkAuto, true, c.tool_name + " (no hook)");
		assert.equal(g.viaCanUseTool, false);
	}
	const hooked = rig("ask-edits");
	for (const c of calls) {
		const g = await gate(hooked.options, c);
		assert.equal(g.viaCanUseTool, true, c.tool_name + " (hook)");
	}
	assert.equal(hooked.asked.length, 1, "the Agent tool asked the user; the inside Read did not");
	assert.match(hooked.asked[0].prompt.title, /^Allow starting a subagent?/);
});
test("Agent in Plan is denied by the hook with a reason, and canUseTool is never reached", async () => {
	const { options, asked } = rig("plan");
	const g = await gate(options, { tool_name: "Agent", tool_input: { description: "d", prompt: "p" } });
	assert.deepEqual(g.hooks, ["deny"]);
	assert.ok(g.reason && g.reason.length > 10);
	assert.equal(g.viaCanUseTool, false);
	assert.equal(asked.length, 0);
});
test("a user 'Allow once' on an Agent call that the hook sent on ends as allow, via canUseTool", async () => {
	const { options } = rig("ask-edits", "Allow once");
	const g = await gate(options, { tool_name: "Agent", tool_input: { description: "d", prompt: "p", mode: "bypassPermissions" } });
	assert.deepEqual(g.hooks, ["ask"]);
	assert.equal(g.outcome, "allow");
	assert.equal(g.result.updatedInput.mode, undefined, "canUseTool still rewrites the input");
});

// --- subagents: judged like the main loop, with the chat's mode --------------------------------------------------
test("a subagent call (agent_id) is judged with the chat's mode, and permission_mode in the hook input is never trusted", async () => {
	for (const claimed of ["bypassPermissions", "trusted", "acceptEdits", "ask-commands", "default", "garbage", undefined]) {
		const plan = rig("plan");
		const r = await mkHook(plan.hookOpts)(hookIn("Write", { file_path: inP("src/x.js"), content: "x" }, { agent_id: "agent-1", agent_type: "general-purpose", permission_mode: claimed }));
		assert.equal(answerOf(r), "deny", `chat in plan, claimed ${claimed}`);
		const edits = rig("ask-edits");
		const r2 = await mkHook(edits.hookOpts)(hookIn("Write", { file_path: inP("src/x.js"), content: "x" }, { agent_id: "agent-1", permission_mode: "plan" }));
		assert.equal(answerOf(r2), "ask", "a claimed plan does not deny in an ask-edits chat");
	}
});
test("a subagent's Write in Plan, and a subagent's outside Read (reads are allowed anywhere), go through the stand-in", async () => {
	const a = rig("plan");
	const g = await gate(a.options, { tool_name: "Write", tool_input: { file_path: inP("src/x.js"), content: "x" }, agent_id: "agent-1", permission_mode: "bypassPermissions" });
	assert.deepEqual([g.hooks[0], g.outcome, g.viaCanUseTool], ["deny", "deny", false]);
	const b = rig("ask-edits");
	const g2 = await gate(b.options, { tool_name: "Read", tool_input: { file_path: outP("o.txt") }, agent_id: "agent-1" });
	assert.deepEqual([g2.hooks[0], g2.outcome, g2.viaCanUseTool], ["ask", "allow", true]);
	assert.equal(b.asked.length, 0);
});
test("the hook follows a mode change of the chat", async () => {
	let mode = "ask-edits";
	const hook = mkHook({ getMode: () => mode, cwd: proj });
	const call = () => hook(hookIn("Write", { file_path: inP("src/x.js"), content: "x" }));
	assert.equal(answerOf(await call()), "ask");
	mode = "plan";
	assert.equal(answerOf(await call()), "deny");
	mode = "trusted";
	assert.equal(answerOf(await call()), "ask", "even in Trusted the hook asks; canUseTool allows");
});

// --- the hook never allows, never defers ---------------------------------------------------------------------------
test("over every tool, mode and a set of odd inputs the hook answers only ask or deny", async () => {
	const seen = new Set();
	for (const [name, [input]] of Object.entries(INPUTS)) {
		for (const mode of MODES) {
			for (const inp of [input, {}, { path: "/proc/1/environ" }, { command: "cat /proc/self/environ" }]) {
				const r = await mkHook({ getMode: () => mode, cwd: proj })(hookIn(name, inp));
				seen.add(answerOf(r));
				assert.equal(r.hookSpecificOutput.hookEventName, "PreToolUse");
				assert.equal(Object.prototype.hasOwnProperty.call(r.hookSpecificOutput, "updatedInput"), false);
			}
		}
	}
	assert.deepEqual([...seen].sort(), ["ask", "deny"]);
});
test("reading a process environment: Plan denies in the hook, other modes ask", async () => {
	const input = { command: "cat /proc/self/environ" };
	assert.equal(answerOf(await mkHook({ getMode: () => "plan", cwd: proj })(hookIn("Bash", input))), "deny");
	assert.equal(answerOf(await mkHook({ getMode: () => "ask-commands", cwd: proj })(hookIn("Bash", input))), "ask");
});

// --- fail closed ---------------------------------------------------------------------------------------------------
test("fail closed: a throw, an unknown shape and a missing tool name all deny", async () => {
	const ok = hookIn("Read", { file_path: inP("a.js") });
	const hook = mkHook({ getMode: () => "ask-edits", cwd: proj });
	assert.equal(answerOf(await hook(ok)), "ask", "control: the good shape asks");
	const bad = [
		undefined, null, "Read", 7, [], {},
		{ ...ok, tool_name: undefined }, { ...ok, tool_name: "" }, { ...ok, tool_name: 5 }, { ...ok, tool_name: ["Read"] },
		{ ...ok, tool_input: undefined }, { ...ok, tool_input: null }, { ...ok, tool_input: "x" }, { ...ok, tool_input: [] },
		{ ...ok, hook_event_name: "PostToolUse" }, { ...ok, hook_event_name: undefined },
	];
	for (const b of bad) {
		const r = await hook(b);
		assert.equal(answerOf(r), "deny", JSON.stringify(b));
		assert.ok(r.hookSpecificOutput.permissionDecisionReason);
	}
});
test("fail closed: getMode throws, returns nothing, or returns an unknown mode", async () => {
	for (const getMode of [() => { throw new Error("boom"); }, async () => { throw new Error("boom"); }, () => undefined, () => "yolo", () => "__proto__"]) {
		assert.equal(answerOf(await mkHook({ getMode, cwd: proj })(hookIn("Read", { file_path: inP("a.js") }))), "deny");
	}
});
test("fail closed: the shared logic throwing (too many path fields) denies", async () => {
	const input = { file_path: inP("a"), path: inP("b"), a_path: "1", b_path: "2", c_path: "3", d_path: "4", e_path: "5", f_path: "6" };
	assert.equal(answerOf(await mkHook({ getMode: () => "ask-edits", cwd: proj })(hookIn("Write", input))), "deny");
});
test("fail closed: our own code taking too long gives deny, not silence", async () => {
	const never = new Promise(() => {});
	const t0 = Date.now();
	const r = await mkHook({ getMode: () => never, cwd: proj, timeoutMs: 30 })(hookIn("Read", { file_path: inP("a.js") }));
	assert.equal(answerOf(r), "deny");
	assert.ok(Date.now() - t0 < 2000);
});
test("makeHooks: one PreToolUse matcher with no pattern (no gaps), onFailure block, and a hook that throws still blocks in the stand-in", async () => {
	const h = perms.makeHooks({ getMode: () => "ask-edits", cwd: proj });
	assert.deepEqual(Object.keys(h), ["PreToolUse"]);
	assert.equal(h.PreToolUse.length, 1);
	assert.equal(h.PreToolUse[0].matcher, undefined, "no matcher, so every tool matches");
	assert.equal(h.PreToolUse[0].onFailure, "block");
	assert.equal(h.PreToolUse[0].hooks.length, 1);
	const asks = await gate({ cwd: proj, canUseTool: async () => ({ behavior: "allow" }), hooks: h }, { tool_name: "Agent", tool_input: {} });
	assert.deepEqual(asks.hooks, ["ask"]);
	const thrower = { hooks: { PreToolUse: [{ hooks: [async () => { throw new Error("x"); }], onFailure: "block" }] }, cwd: proj, canUseTool: async () => ({ behavior: "allow" }) };
	assert.equal((await gate(thrower, { tool_name: "Read", tool_input: { file_path: inP("a") } })).outcome, "deny");
	const lenient = { ...thrower, hooks: { PreToolUse: [{ hooks: [async () => { throw new Error("x"); }] }] } };
	assert.equal((await gate(lenient, { tool_name: "Read", tool_input: { file_path: inP("a") } })).outcome, "allow", "control: without onFailure the real SDK lets the call go on");
});

// --- the adapter hands the SDK the hooks ---------------------------------------------------------------------------
test("the adapter passes hooks next to canUseTool; the gate runs end to end with the chat's mode", async () => {
	const { createClaudeAdapter } = require("../src/agents/claude");
	const sdk = await standIn();
	sdk.reset();
	const cwd = fs.mkdtempSync(path.join(tmp, "p-"));
	const ks = { read: async () => ({ source: "stored", key: "k-test-not-real" }), status: async () => ({ source: "stored" }), set: async () => ({}), clear: async () => ({}) };
	const ad = createClaudeAdapter({ enginePath: () => ({ path: "C:/stub/claude.exe" }), keystore: ks, configDir: path.join(tmp, "cfg"), isPackaged: () => false, loadSdk: async () => sdk, killTree: () => {}, getSettings: () => ({}), env: {} });
	const ready = [];
	const asked = [];
	const sink = { isCurrent: () => true, ready: (h, d) => ready.push(d), record: () => {}, stderr: () => {}, exit: () => {}, ask: async (h, prompt) => (asked.push(prompt.title), "Allow once") };
	sdk.setScript([
		{ type: "system", subtype: "init", session_id: "s" },
		{ __tool_call: { tool_name: "Agent", tool_input: { description: "d", prompt: "p" }, permission_mode: "bypassPermissions" } },
		{ __tool_call: { tool_name: "Write", tool_input: { file_path: path.join(cwd, "x.txt"), content: "x" }, agent_id: "agent-1", permission_mode: "bypassPermissions" } },
		{ __tool_call: { tool_name: "Read", tool_input: { file_path: path.join(cwd, "x.txt") } } },
		{ type: "result", subtype: "success", is_error: false, result: "ok", total_cost_usd: 0, session_id: "s" },
	]);
	const h = ad.start({ cwd, mode: "plan" }, sink);
	for (let i = 0; i < 400 && !ready.length; i++) await new Promise((r) => setTimeout(r, 5));
	const c = sdk.calls[0];
	assert.deepEqual(c.options.hooks, { PreToolUse: [{ matcher: null, hooks: 1, onFailure: "block" }] });
	assert.ok(ad.send(h, { type: "prompt", message: "go" }));
	for (let i = 0; i < 400 && c.gates.length < 3; i++) await new Promise((r) => setTimeout(r, 5));
	assert.deepEqual(c.gates.map((g) => [g.call.tool_name, g.hooks[0], g.outcome, g.viaCanUseTool]), [["Agent", "deny", "deny", false], ["Write", "deny", "deny", false], ["Read", "ask", "allow", true]]);
	assert.deepEqual(asked, [], "Plan asks nobody");
	ad.stop(h);
});

// --- replay of the real run (capture-hook-gate, normalised), three passes ---------------------------------------------
const real3 = (p) => (typeof p === "string" ? p.replace(/<proj>/g, proj).replace(/<outside>/g, outside) : Array.isArray(p) ? p.map(real3) : p && typeof p === "object" ? Object.fromEntries(Object.entries(p).map(([k, v]) => [k, real3(v)])) : p);
const PASSES = FIXTURE.passes;
test("replay fixture: the capture shows the gate gap (pass A) and what a hook that asks fixes (pass B)", () => {
	const { "A-hook-decides-nothing": A, "B-hook-asks-every-call": B, "C-hook-denies-agent-rewrites-read": C } = PASSES;
	assert.equal(A.calls.length, 5);
	assert.deepEqual(A.reachedCanUseTool.map((c) => c.tool_name), ["Read", "PowerShell"], "A: canUseTool never saw the Agent tool or the inside Reads");
	assert.equal(B.reachedCanUseTool.length, 5, "B: an ask from the hook sent all five to canUseTool");
	assert.equal(C.calls.length, 3);
	assert.ok(A.calls.some((c) => c.agent_id) && B.calls.some((c) => c.agent_id), "a subagent's call is among them");
	assert.ok(!JSON.stringify(FIXTURE).match(/[A-Za-z]:\\Users|toolu_|sk-ant/));
});
const EXPECT = {
	// Mode "default" = Ask before edits, nobody answers: reads pass (outside too), PowerShell and the Agent tool ask and end as deny.
	"A-hook-decides-nothing": { hooks: ["ask", "ask", "ask", "ask", "ask"], via: [true, true, true, true, true], outcomes: ["allow", "allow", "deny", "deny", "allow"] },
	"B-hook-asks-every-call": { hooks: ["ask", "ask", "ask", "ask", "ask"], via: [true, true, true, true, true], outcomes: ["allow", "allow", "deny", "deny", "allow"] },
	"C-hook-denies-agent-rewrites-read": { hooks: ["ask", "ask", "ask"], via: [true, true, true], outcomes: ["allow", "deny", "allow"] },
};
for (const [pass, want] of Object.entries(EXPECT)) {
	test(`replay ${pass}: every call the capture's hook saw now reaches the decision`, async () => {
		const { options } = rig("ask-edits");
		const got = { hooks: [], via: [], outcomes: [] };
		for (const c of real3(PASSES[pass].calls)) {
			const g = await gate(options, c);
			got.hooks.push(g.hooks[0]);
			got.via.push(g.viaCanUseTool);
			got.outcomes.push(g.outcome);
		}
		assert.deepEqual(got, want);
		assert.ok(got.via.length > PASSES[pass].reachedCanUseTool.length - 1);
	});
}
test("replay of pass A without our hook gives what the capture shows: only the outside Read and PowerShell reach canUseTool", async () => {
	const { options } = rig("ask-edits");
	const via = [];
	for (const c of real3(PASSES["A-hook-decides-nothing"].calls)) via.push((await gate({ ...options, hooks: undefined }, c)).viaCanUseTool);
	assert.deepEqual(via, [false, true, true, false, false]);
});
test("replay in Plan: the same calls, the subagent's too, all end as the logic decides, none allowed by the hook", async () => {
	const { options } = rig("plan");
	const outcomes = [];
	for (const c of real3(PASSES["B-hook-asks-every-call"].calls)) {
		const g = await gate(options, c);
		assert.notEqual(g.hooks[0], "allow");
		outcomes.push(g.hooks[0] + ":" + g.outcome);
	}
	assert.deepEqual(outcomes, ["ask:allow", "ask:allow", "deny:deny", "deny:deny", "ask:allow"]);
});
