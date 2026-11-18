"use strict";
// Claude agent permissions (phase 7, T6): every cell of mode x tool category, the bypass attempts for the Bash tool,
// each scripted answer, grants per chat, and fail-closed behaviour. No SDK, no Electron, no model.
// PERM_STUB=1 runs the same tests against an always-allow stub (the negative control: they must fail).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const logic = require("../src/permission-logic");
const real = require("../src/agents/claude/permissions");

const stub = {
	...real,
	makeCanUseTool: () => async (toolName, input) => ({ behavior: "allow", updatedInput: input }),
};
const P = process.env.PERM_STUB ? stub : real;

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "claude-perm-")));
const proj = path.join(tmp, "proj");
const outside = path.join(tmp, "outside");
fs.mkdirSync(path.join(proj, "src"), { recursive: true });
fs.mkdirSync(outside);
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// Builds a handler with a scripted asker. answer: a string, "undefined", "throw", or a function.
function rig(mode, answer) {
	const asked = [];
	const ask = async (prompt, meta) => {
		asked.push({ prompt, meta });
		if (answer === "throw") throw new Error("panel crashed");
		return typeof answer === "function" ? answer(prompt) : answer === "undefined" ? undefined : answer;
	};
	const grants = logic.createGrants();
	const can = P.makeCanUseTool({ getMode: () => mode, ask, grants, cwd: proj });
	if (P.makeCanUseTool === stub.makeCanUseTool) can.grants = grants;
	return { can, asked, grants };
}
const inP = (f) => path.join(proj, f);
const outP = (f) => path.join(outside, f);

const ALL = { plan: "allow", "ask-edits": "allow", "ask-commands": "allow", trusted: "allow" };
const EDIT_IN = { plan: "deny", "ask-edits": "ask", "ask-commands": "allow", trusted: "allow" };
const ASK_ALL = { plan: "deny", "ask-edits": "ask", "ask-commands": "ask", trusted: "allow" };

// [label, tool, input, expected outcome per mode]. "ask" means the asker is called once; nobody answers, so it ends as deny.
const CELLS = [
	["read (Read, in project)", "Read", { file_path: inP("src/a.js") }, ALL],
	["search (Grep)", "Grep", { pattern: "x", path: inP("src") }, ALL],
	["search (Glob)", "Glob", { pattern: "*.js" }, ALL],
	["todo (TodoWrite)", "TodoWrite", { todos: [] }, ALL],
	["edit in project (Edit)", "Edit", { file_path: inP("src/a.js"), old_string: "a", new_string: "b" }, EDIT_IN],
	["edit in project (Write)", "Write", { file_path: inP("src/new.js"), content: "x" }, EDIT_IN],
	["edit in project (MultiEdit)", "MultiEdit", { file_path: inP("src/a.js"), edits: [] }, EDIT_IN],
	["edit in project (NotebookEdit)", "NotebookEdit", { notebook_path: inP("n.ipynb"), new_source: "x" }, EDIT_IN],
	["edit outside the project", "Write", { file_path: outP("x.txt"), content: "x" }, ASK_ALL],
	["edit of a protected file", "Write", { file_path: inP(".git/config"), content: "x" }, ASK_ALL],
	["read-only shell (Bash)", "Bash", { command: "rg TODO src" }, ALL],
	["mutating shell (Bash)", "Bash", { command: "npm install left-pad" }, ASK_ALL],
	["mutating shell (PowerShell)", "PowerShell", { command: "Remove-Item x" }, ASK_ALL],
	["subagent (Task)", "Task", { description: "d", prompt: "do it", subagent_type: "general-purpose" }, ASK_ALL],
	["subagent (Agent)", "Agent", { description: "d", prompt: "do it" }, ASK_ALL],
	["unknown tool (WebFetch)", "WebFetch", { url: "https://example.com" }, ASK_ALL],
	["unknown tool (made-up)", "SomethingNew", { x: 1 }, ASK_ALL],
	["MCP tool", "mcp__srv__do", { a: 1 }, ASK_ALL],
];
for (const [label, tool, input, want] of CELLS) {
	for (const mode of logic.MODE_IDS) {
		test(`cell: ${label} in ${mode} -> ${want[mode]}`, async () => {
			const { can, asked } = rig(mode, "undefined");
			const r = await can(tool, input, { signal: new AbortController().signal });
			if (want[mode] === "allow") {
				assert.equal(r.behavior, "allow");
				assert.equal(asked.length, 0);
				assert.deepEqual(r.updatedInput, input);
			} else {
				assert.equal(r.behavior, "deny");
				assert.ok(r.message && r.message.length > 10);
				assert.equal(asked.length, want[mode] === "ask" ? 1 : 0, "asked or not");
			}
			assert.equal(Object.prototype.hasOwnProperty.call(r, "updatedPermissions"), false);
		});
	}
}

test("every mode maps to SDK options; trusted alone skips, an unreadable mode never does", () => {
	assert.equal(P.sdkModeFor("plan").permissionMode, "plan");
	assert.equal(P.sdkModeFor("ask-edits").permissionMode, "default");
	assert.equal(P.sdkModeFor("ask-commands").permissionMode, "default");
	assert.deepEqual(P.sdkModeFor("trusted"), { permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true });
	for (const bad of [undefined, null, "yolo", 7, "__proto__", "constructor"]) assert.equal(P.sdkModeFor(bad).permissionMode, "default", String(bad));
	for (const id of logic.MODE_IDS) assert.ok(P.SDK_MODES[id], id);
});

test("name table: Claude names reach the right category; unmapped names never borrow Pi's lower case names", () => {
	const kind = (n) => logic.classify(P.logicName(n));
	for (const n of ["Read", "Grep", "Glob", "LS", "TodoWrite"]) assert.equal(kind(n), "safe", n);
	for (const n of ["Edit", "Write", "MultiEdit", "NotebookEdit"]) assert.equal(kind(n), "edit", n);
	for (const n of ["Bash", "PowerShell"]) assert.equal(kind(n), "shell", n);
	for (const n of ["Task", "Agent"]) assert.equal(kind(n), "subagent", n);
	for (const n of ["bash", "edit", "read", "subagent", "READ", "Bash ", "", undefined, null, 5, "__proto__", "toString"]) assert.equal(kind(n), "command", String(n));
});

// --- bypass attempts (from permission-attacks.test.js) through the Bash tool -----------------------------
const ATTACKS = ["echo x > out.txt", "rg TODO src > out.txt", "ls && rm -rf x", "rg TODO src; del x", "rg TODO src | sh", "cat $(id)", "rg \"`id`\" src", "find src *elete", "rg TODO -*", "git log --output=README.md", "find . -name x -delete", "rg --pre=sh x", "cat ..\\..\\secret.txt > ..\\..\\x", "cat //attacker.example/share/x", "cat http://x/y", "git --version; rm x"];
for (const c of ATTACKS) {
	test(`bypass: Bash "${c}" is never allowed unasked`, async () => {
		for (const mode of ["plan", "ask-edits", "ask-commands"]) {
			const { can, asked } = rig(mode, "undefined");
			const r = await can("Bash", { command: c });
			assert.equal(r.behavior, "deny", `${mode}: ${c}`);
			if (mode === "plan") assert.equal(asked.length, 0, "plan blocks without asking");
		}
	});
}
test("bypass: edits that climb out with .. or use URLs and network paths are outside, so they ask in Ask before commands", async () => {
	for (const p of [path.join(proj, "..", "outside", "x.txt"), "..\\..\\x.txt", "../../x.txt", require("url").pathToFileURL(outP("x.txt")).href, "file://evilhost/share/x"]) {
		const { can, asked } = rig("ask-commands", "undefined");
		const r = await can("Write", { file_path: p, content: "x" });
		assert.equal(r.behavior, "deny", p);
		assert.equal(asked.length, 1, p);
		assert.match(asked[0].prompt.title, /OUTSIDE|network/i, p);
	}
});
test("bypass: a hand-picked tool name 'bash' or 'edit' is an unknown tool and asks, in lower case too", async () => {
	for (const n of ["bash", "edit", "read", "write"]) {
		const { can, asked } = rig("ask-commands", "undefined");
		const r = await can(n, { command: "rg x", file_path: inP("a.js"), path: inP("a.js") });
		assert.equal(r.behavior, "deny", n);
		assert.equal(asked.length, 1, n);
	}
});

// --- scripted answers -------------------------------------------------------------------------------------
const ASKING = ["Bash", { command: "npm test" }];
test("answer 'Allow once' allows, with updatedInput and no updatedPermissions", async () => {
	const { can, asked } = rig("ask-commands", "Allow once");
	const r = await can(...ASKING);
	assert.deepEqual(r, { behavior: "allow", updatedInput: { command: "npm test" } });
	assert.deepEqual(asked[0].prompt.options, ["Allow once", "Allow for this chat", "Deny"]);
	assert.match(asked[0].prompt.title, /^Allow this command\?/);
});
test("each other answer denies: Deny, undefined, a thrown error, junk, wrong case, an option that was not offered", async () => {
	for (const a of ["Deny", "undefined", "throw", "allow once", "ALLOW ONCE", "Allow once ", "yes", "", null, 1, {}, ["Allow once"]]) {
		const { can } = rig("ask-commands", a);
		const r = await can(...ASKING);
		assert.equal(r.behavior, "deny", String(a));
		assert.ok(typeof r.message === "string" && r.message.length > 0);
	}
	// "Allow for this chat" is not offered for a protected file: it must not allow
	const { can } = rig("ask-commands", "Allow for this chat");
	assert.equal((await can("Write", { file_path: inP(".git/config"), content: "x" })).behavior, "deny");
});
test("an aborted signal denies: before asking, and while the question is open", async () => {
	const pre = new AbortController();
	pre.abort();
	const a = rig("ask-commands", "Allow once");
	assert.equal((await a.can(...ASKING, { signal: pre.signal })).behavior, "deny");
	assert.equal(a.asked.length, 0);
	const mid = new AbortController();
	const b = rig("ask-commands", () => new Promise(() => {})); // never answers
	const p = b.can(...ASKING, { signal: mid.signal });
	setImmediate(() => mid.abort());
	assert.equal((await p).behavior, "deny");
	// an answer that arrives together with the abort does not allow
	const late = new AbortController();
	const c = rig("ask-commands", () => {
		late.abort();
		return "Allow once";
	});
	assert.equal((await c.can(...ASKING, { signal: late.signal })).behavior, "deny");
});
test("fail closed: no asker, a throwing mode reader, an unreadable mode, odd tool names and input", async () => {
	const noAsk = P.makeCanUseTool({ getMode: () => "ask-commands", cwd: proj });
	assert.equal((await noAsk(...ASKING)).behavior, "deny");
	const boom = P.makeCanUseTool({
		getMode: () => {
			throw new Error("x");
		},
		ask: async () => "Allow once",
		cwd: proj,
	});
	assert.equal((await boom("Read", { file_path: inP("a") })).behavior, "deny");
	for (const m of [undefined, "yolo", 3]) {
		const r = P.makeCanUseTool({ getMode: () => m, ask: async () => "Allow once", cwd: proj });
		assert.equal((await r("Write", { file_path: inP("a"), content: "x" })).behavior, "deny", String(m));
	}
	const { can } = rig("ask-commands", "undefined");
	for (const bad of [undefined, null, ""]) assert.equal((await can(bad, {})).behavior, "deny", String(bad));
	assert.equal((await can("Write", undefined)).behavior, "deny", "an edit with no input is blocked");
	assert.equal((await can("Bash", null)).behavior, "deny");
});
test("a plan-mode block carries a reason the model can read", async () => {
	const { can } = rig("plan", "Allow once");
	const r = await can("Edit", { file_path: inP("a.js") });
	assert.equal(r.behavior, "deny");
	assert.match(r.message, /plan/i);
});
test("the SDK's permission_denials are not needed: the handler works from the call alone", async () => {
	const { can } = rig("ask-commands", "Deny");
	const r = await can(...ASKING, { signal: undefined, suggestions: [{ type: "addRules" }] });
	assert.deepEqual(Object.keys(r).sort(), ["behavior", "message"]);
});

// --- grants (in memory, per chat) ---------------------------------------------------------------------------
test("Allow for this chat: the exact command is remembered for that chat only; a different command still asks", async () => {
	const a = rig("ask-commands", "Allow for this chat");
	assert.equal((await a.can("Bash", { command: "npm test" })).behavior, "allow");
	assert.equal(a.asked.length, 1);
	assert.equal((await a.can("Bash", { command: "npm test" })).behavior, "allow");
	assert.equal(a.asked.length, 1, "second call did not ask");
	assert.equal((await a.can("Bash", { command: "npm test -- --watch" })).behavior, "allow");
	assert.equal(a.asked.length, 2, "another command asks");
	const other = rig("ask-commands", "Deny"); // another chat, own grants
	assert.equal((await other.can("Bash", { command: "npm test" })).behavior, "deny");
	assert.equal(other.asked.length, 1);
});
test("Allow for this chat on an edit covers the project, not protected files, and clearing the grants forgets it", async () => {
	const a = rig("ask-edits", "Allow for this chat");
	assert.equal((await a.can("Edit", { file_path: inP("src/a.js") })).behavior, "allow");
	assert.equal((await a.can("Write", { file_path: inP("src/b.js"), content: "x" })).behavior, "allow");
	assert.equal(a.asked.length, 1);
	// a protected file is not offered "for this chat", so that scripted answer does not allow it, and it asks again
	assert.equal((await a.can("Write", { file_path: inP(".git/config"), content: "x" })).behavior, "deny");
	assert.equal(a.asked.length, 2);
	logic.clearGrants(a.grants);
	await a.can("Edit", { file_path: inP("src/a.js") });
	assert.equal(a.asked.length, 3, "after clearing, it asks again");
	const noGrant = rig("ask-edits", "Deny");
	assert.equal((await noGrant.can("Edit", { file_path: inP("src/a.js") })).behavior, "deny");
});
test("a grant lives only in the grants object the handler exposes", async () => {
	const a = rig("ask-commands", "Allow for this chat");
	await a.can("Bash", { command: "npm test" });
	assert.equal(a.can.grants, a.grants);
	assert.ok(a.grants.keys.has("cmd:npm test"));
});
test("updatedInput is a copy of the judged input", async () => {
	const input = { command: "rg TODO src", nested: { a: [1] } };
	const { can } = rig("ask-commands", "Deny");
	const r = await can("Bash", input);
	assert.equal(r.behavior, "allow");
	assert.notEqual(r.updatedInput, input);
	assert.notEqual(r.updatedInput.nested, input.nested);
	assert.deepEqual(r.updatedInput, input);
});
test("the mode is read on every call, so a switch mid-chat takes effect at once", async () => {
	let mode = "ask-commands";
	const can = P.makeCanUseTool({ getMode: () => mode, ask: async () => undefined, cwd: proj });
	assert.equal((await can("Edit", { file_path: inP("a.js") })).behavior, "allow");
	mode = "plan";
	assert.equal((await can("Edit", { file_path: inP("a.js") })).behavior, "deny");
});

// --- review round: every path field, Agent mode, sandbox flag, hardened git, odd decisions, tool table, grants per shell, /proc environ ---
test("every path field is judged and the strictest wins (NotebookEdit with a file_path inside and a notebook_path outside)", async () => {
	const { can, asked } = rig("ask-commands", "undefined");
	const r = await can("NotebookEdit", { file_path: inP("a.txt"), notebook_path: outP("x.ipynb"), new_source: "x" });
	assert.equal(r.behavior, "deny");
	assert.equal(asked.length, 1);
	const swapped = rig("ask-commands", "undefined");
	assert.equal((await swapped.can("NotebookEdit", { file_path: outP("a.txt"), notebook_path: inP("x.ipynb") })).behavior, "deny");
	assert.equal(swapped.asked.length, 1);
	const inside = rig("ask-commands", "undefined");
	assert.equal((await inside.can("NotebookEdit", { file_path: inP("a.txt"), notebook_path: inP("x.ipynb") })).behavior, "allow");
	const plan = rig("plan", "Allow once");
	assert.equal((await plan.can("NotebookEdit", { file_path: inP("a.txt"), notebook_path: inP("x.ipynb") })).behavior, "deny");
});
test("a network notebook_path or file_path on a read asks; in Plan it is blocked without asking", async () => {
	for (const input of [{ notebook_path: "//evil/s/a.ipynb" }, { file_path: "//evil/s/a.ipynb" }, { file_path: inP("a.js"), notebook_path: "//evil/s/a.ipynb" }, { path: inP("src"), local_path: "\\\\evil\\s\\x" }]) {
		for (const tool of ["Read", "Grep"]) {
			const { can, asked } = rig("ask-commands", "undefined");
			assert.equal((await can(tool, input)).behavior, "deny", tool + JSON.stringify(input));
			assert.equal(asked.length, 1, tool + JSON.stringify(input));
			const p = rig("plan", "Allow once");
			assert.equal((await p.can(tool, input)).behavior, "deny");
			assert.equal(p.asked.length, 0);
		}
	}
});
test("Agent and Task: updatedInput never carries a mode, on every allow path (the value that skips permission checks too)", async () => {
	for (const tool of ["Agent", "Task"]) {
		for (const m of ["bypassPermissions", "acceptEdits", "auto", "dontAsk", "default", "plan"]) {
			const input = { description: "d", prompt: "do it", mode: m };
			const once = rig("ask-commands", "Allow once");
			const r1 = await once.can(tool, input);
			assert.equal(r1.behavior, "allow");
			assert.equal("mode" in r1.updatedInput, false, `${tool} ${m} once`);
			assert.equal(r1.updatedInput.prompt, "do it");
			const chat = rig("ask-commands", "Allow for this chat");
			await chat.can(tool, input);
			const r2 = await chat.can(tool, input); // from the grant, no question
			assert.equal(chat.asked.length, 1);
			assert.equal("mode" in r2.updatedInput, false, `${tool} ${m} grant`);
			const tr = rig("trusted", undefined);
			assert.equal("mode" in (await tr.can(tool, input)).updatedInput, false, `${tool} ${m} trusted`);
		}
	}
});
test("Bash and PowerShell: dangerouslyDisableSandbox is removed from updatedInput, for a read-only and an asked command", async () => {
	for (const tool of ["Bash", "PowerShell"]) {
		const ro = rig("ask-commands", "undefined");
		const r1 = await ro.can(tool, { command: "rg TODO src", dangerouslyDisableSandbox: true });
		assert.equal(r1.behavior, "allow");
		assert.equal("dangerouslyDisableSandbox" in r1.updatedInput, false, tool + " read-only");
		assert.equal(r1.updatedInput.command, "rg TODO src");
		const asked = rig("ask-commands", "Allow once");
		const r2 = await asked.can(tool, { command: "npm test", dangerouslyDisableSandbox: true });
		assert.equal(r2.behavior, "allow");
		assert.equal(asked.asked.length, 1);
		assert.equal("dangerouslyDisableSandbox" in r2.updatedInput, false, tool + " asked");
		const tr = rig("trusted", undefined);
		assert.equal("dangerouslyDisableSandbox" in (await tr.can(tool, { command: "x", dangerouslyDisableSandbox: true })).updatedInput, false);
	}
});
test("a read-only git command runs in its hardened form: updatedInput.command is the logic's rewrite, not the model's text", async () => {
	const { can, asked } = rig("ask-commands", "undefined");
	const r = await can("Bash", { command: "git status" });
	assert.equal(r.behavior, "allow");
	assert.equal(asked.length, 0);
	assert.notEqual(r.updatedInput.command, "git status");
	assert.match(r.updatedInput.command, /^git -c core\.fsmonitor=false -c core\.hooksPath=\S+ .*--no-pager status$/);
	const want = logic.decide({ mode: "ask-commands", toolName: "bash", input: { command: "git status" }, cwd: proj, grants: logic.createGrants() }).rewrite;
	assert.equal(r.updatedInput.command, want);
});
test("a decision with an unexpected action denies (never allows), whatever the logic returned", async () => {
	const orig = logic.decide;
	try {
		for (const odd of [{ action: "allow-always" }, { action: "ALLOW" }, { action: undefined, rewrite: "x" }, {}, null, undefined, "allow"]) {
			logic.decide = () => odd;
			const { can, asked } = rig("ask-commands", "Allow once");
			const r = await can("Bash", { command: "rg x" });
			assert.equal(r.behavior, "deny", JSON.stringify(odd));
			assert.equal(asked.length, 0);
		}
	} finally {
		logic.decide = orig;
	}
});
const SDK_TOOLS = ["Agent", "Bash", "ExitPlanMode", "Edit", "Read", "Write", "Glob", "Grep", "TaskStop", "ListMcpResources", "RefreshMcpTools", "Mcp", "NotebookEdit", "ReadMcpResourceDir", "ReadMcpResource", "ReportFindings", "TodoWrite", "WebFetch", "WebSearch", "AskUserQuestion", "SendFeedback", "ClaudeDesign", "Projects", "EnterPlanMode", "TaskCreate", "TaskGet", "TaskUpdate", "TaskList", "Workflow", "CronCreate", "CronDelete", "CronList", "ScheduleWakeup", "RemoteTrigger", "ShowOnboardingRolePicker", "OfferChromeSetup", "ReadNotifications", "Monitor", "ProposeSkills", "ProposeGoal", "Artifact", "PushNotification", "EnterWorktree", "ExitWorktree"];
test("every tool in the SDK type file is named in the table with a deliberate category", () => {
	for (const n of SDK_TOOLS) assert.ok(Object.prototype.hasOwnProperty.call(P.TOOL_TABLE, n), n + " is not in the table");
	const safe = ["Read", "Glob", "Grep", "TodoWrite", "AskUserQuestion", "EnterPlanMode", "TaskCreate", "TaskGet", "TaskUpdate", "TaskList"];
	const kinds = { Edit: "edit", Write: "edit", NotebookEdit: "edit", Bash: "shell", Agent: "subagent" };
	for (const n of SDK_TOOLS) assert.equal(logic.classify(P.logicName(n)), safe.includes(n) ? "safe" : kinds[n] || "command", n);
});
test("the tools that reach out or start things ask in Ask before commands and are blocked in Plan, with no question", async () => {
	for (const n of ["Monitor", "WebFetch", "WebSearch", "ReadMcpResource", "ReadMcpResourceDir", "Mcp", "CronCreate", "EnterWorktree", "ExitPlanMode", "Workflow", "RemoteTrigger", "Artifact"]) {
		const a = rig("ask-commands", "undefined");
		assert.equal((await a.can(n, { command: "x", url: "https://example.com" })).behavior, "deny", n);
		assert.equal(a.asked.length, 1, n);
		const p = rig("plan", "Allow once");
		assert.equal((await p.can(n, {})).behavior, "deny", n);
		assert.equal(p.asked.length, 0, n);
	}
});
test("a grant for a Bash command does not cover the same text in PowerShell, nor the other way round", async () => {
	const a = rig("ask-commands", "Allow for this chat");
	assert.equal((await a.can("Bash", { command: "npm test" })).behavior, "allow");
	assert.equal(a.asked.length, 1);
	assert.equal((await a.can("PowerShell", { command: "npm test" })).behavior, "allow");
	assert.equal(a.asked.length, 2, "PowerShell asked again");
	assert.equal((await a.can("PowerShell", { command: "npm test" })).behavior, "allow");
	assert.equal(a.asked.length, 2, "its own grant works");
	assert.equal((await a.can("Bash", { command: "npm test" })).behavior, "allow");
	assert.equal(a.asked.length, 2);
	const b = rig("ask-commands", "Allow for this chat");
	await b.can("PowerShell", { command: "npm run x" });
	await b.can("Bash", { command: "npm run x" });
	assert.equal(b.asked.length, 2, "a PowerShell grant does not cover Bash");
	logic.clearGrants(b.grants);
	await b.can("PowerShell", { command: "npm run x" });
	assert.equal(b.asked.length, 3, "clearing the grants clears PowerShell's too");
});
test("reading /proc/<anything>/environ asks (once only) and is denied in Plan, through the shell and the read tools", async () => {
	const cases = [["Bash", { command: "cat /proc/self/environ" }], ["Bash", { command: "cat /proc/1234/environ" }], ["Bash", { command: "rg X /proc/self/environ" }], ["Read", { file_path: "/proc/self/environ" }], ["Read", { file_path: "\\proc\\self\\environ" }], ["Grep", { pattern: "KEY", path: "/proc/12/environ" }], ["Bash", { command: "cat /proc/self/../self/environ" }]];
	for (const [tool, input] of cases) {
		for (const mode of ["ask-edits", "ask-commands"]) {
			const a = rig(mode, "Allow once");
			assert.equal((await a.can(tool, input)).behavior, "allow", `${mode} ${tool} ${JSON.stringify(input)} after Allow`);
			assert.equal(a.asked.length, 1, `${mode} ${JSON.stringify(input)} asks`);
			assert.deepEqual(a.asked[0].prompt.options, ["Allow once", "Deny"], "no 'for this chat'");
			await a.can(tool, input);
			assert.equal(a.asked.length, 2, "asks every time");
			const n = rig(mode, "undefined");
			assert.equal((await n.can(tool, input)).behavior, "deny");
			assert.equal((await rig(mode, "Allow for this chat").can(tool, input)).behavior, "deny", "not offered, so it does not allow");
		}
		const p = rig("plan", "Allow once");
		const r = await p.can(tool, input);
		assert.equal(r.behavior, "deny", `plan ${JSON.stringify(input)}`);
		assert.equal(p.asked.length, 0);
	}
	const ok = rig("ask-commands", "undefined");
	assert.equal((await ok.can("Bash", { command: "cat /etc/hostname" })).behavior, "allow");
	assert.equal((await ok.can("Read", { file_path: inP("src/environment.js") })).behavior, "allow");
});

// --- second review round ---------------------------------------------------------------------------------
test("ExitPlanMode: allowedPrompts is removed from updatedInput on every allow path (asked and trusted)", async () => {
	const input = { plan: "p", allowedPrompts: [{ tool: "Bash", prompt: "run tests" }] };
	for (const mode of ["ask-edits", "ask-commands", "trusted"]) {
		const r = await rig(mode, "Allow once").can("ExitPlanMode", input);
		assert.equal(r.behavior, "allow", mode);
		assert.equal("allowedPrompts" in r.updatedInput, false, mode);
		assert.equal(r.updatedInput.plan, "p");
	}
	assert.ok(input.allowedPrompts, "the caller's input is not changed");
});

test("anything that touches /proc asks, and Plan denies it, however the text is split or quoted", async () => {
	const cases = [
		["Grep", { pattern: "sk-ant", path: "/proc/self" }],
		["Grep", { path: "/proc/self", glob: "environ" }],
		["Grep", { pattern: "x", path: "\\proc\\self" }],
		["Read", { file_path: "\\proc\\self\\cmdline" }],
		["Bash", { command: "grep -r ANTHROPIC /proc/self/" }],
		["Bash", { command: 'cat /proc/self/e""nviron' }],
		["Bash", { command: "cat /pr'oc'/self/environ" }],
		["Bash", { command: "cat //proc//self/environ" }],
	];
	for (const [tool, input] of cases) {
		const a = rig("ask-commands", "Deny");
		assert.equal((await a.can(tool, input)).behavior, "deny", JSON.stringify(input));
		assert.equal(a.asked.length, 1, "asks: " + JSON.stringify(input));
		const p = rig("plan", "Allow once");
		assert.equal((await p.can(tool, input)).behavior, "deny", "plan " + JSON.stringify(input));
		assert.equal(p.asked.length, 0);
	}
	const ok = rig("ask-commands", "undefined");
	assert.equal((await ok.can("Read", { file_path: inP("src/process.js") })).behavior, "allow");
	assert.equal((await ok.can("Grep", { pattern: "proc", path: inP("src") })).behavior, "allow");
});

test("every part of EXTRA_PATH_KEY is judged: path, file, dir, in any case", async () => {
	for (const key of ["notebook_path", "other_file", "target_dir", "TARGET_DIR", "Notebook_Path", "OtherFile"]) {
		const a = rig("ask-commands", "undefined");
		const r = await a.can("Write", { file_path: inP("src/a.js"), content: "x", [key]: outP("x.txt") });
		assert.equal(r.behavior, "deny", key);
		assert.equal(a.asked.length, 1, key + " outside the project asks");
	}
});

test("too many path fields to judge: denied, not waved through", async () => {
	const a = rig("ask-commands", "Allow once");
	const full = { path: inP("a"), file_path: inP("b"), filePath: inP("c"), file: inP("d"), filename: inP("e"), content: "x" };
	assert.equal((await a.can("Write", { ...full, extra_dir: outP("x") })).behavior, "deny");
	assert.equal(a.asked.length, 0);
	assert.equal((await a.can("Write", full)).behavior, "allow", "the same call without the extra field is fine");
});

test("ask prompts show the plain tool name and make no claim about the subagent's own tools", async () => {
	const w = rig("ask-commands", "Deny");
	await w.can("WebFetch", { url: "https://example.com" });
	assert.match(w.asked[0].prompt.title, /WebFetch/);
	assert.doesNotMatch(w.asked[0].prompt.title, /claude:/);
	for (const tool of ["Agent", "Task"]) {
		const s = rig("ask-commands", "Deny");
		await s.can(tool, { description: "d", prompt: "do it" });
		const t = s.asked[0].prompt.title;
		assert.doesNotMatch(t, /not controlled by the permission mode|are checked|are controlled/i, tool);
		assert.match(t, /starting the subagent/i, tool);
		assert.deepEqual(s.asked[0].prompt.options.slice(-1), ["Deny"]);
	}
});
