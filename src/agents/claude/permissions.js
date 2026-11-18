// Permissions for the Claude agent. Pure: no Electron, no SDK import. The decisions come from the shared logic (src/permission-logic.js,
// the same one Pi's extension uses); this file only maps Claude's names onto it and shapes the answers the SDK wants.
// Fail closed everywhere: an unknown tool asks; an answer that is not exactly an offered "Allow" option, a thrown error and an
// aborted signal all deny. We never return updatedPermissions (it would persist an "always allow" outside our control).
"use strict";

const logic = require("../../permission-logic");

// Claude's tool names -> the names permission-logic.js knows (its categories: safe, edit, shell, subagent; anything else is a command).
// Exact, case-sensitive. Every tool in the SDK's type file (sdk-tools.d.ts) is named here with a deliberate category:
//   safe: reads, search, in-chat task lists, a question to the user, EnterPlanMode (it only makes the chat stricter).
//   edit / shell / subagent: as in the shared logic.
//   ASK("<Name>") is a command to the logic: it asks in every mode and is blocked in Plan. These reach the network, other
//     processes, MCP servers, the scheduler, other worktrees or the user's account, or leave Plan mode.
// A name that is not here is unknown and asks too, see logicName().
const ASK = (n) => "claude:" + n;
const TOOL_TABLE = Object.freeze({
	ExitPlanMode: ASK("ExitPlanMode"),
	WebFetch: ASK("WebFetch"),
	WebSearch: ASK("WebSearch"),
	Monitor: ASK("Monitor"),
	TaskStop: ASK("TaskStop"),
	ReadMcpResource: ASK("ReadMcpResource"),
	ReadMcpResourceDir: ASK("ReadMcpResourceDir"),
	ListMcpResources: ASK("ListMcpResources"),
	RefreshMcpTools: ASK("RefreshMcpTools"),
	Mcp: ASK("Mcp"),
	ReportFindings: ASK("ReportFindings"),
	SendFeedback: ASK("SendFeedback"),
	ClaudeDesign: ASK("ClaudeDesign"),
	Projects: ASK("Projects"),
	Workflow: ASK("Workflow"),
	CronCreate: ASK("CronCreate"),
	CronDelete: ASK("CronDelete"),
	CronList: ASK("CronList"),
	ScheduleWakeup: ASK("ScheduleWakeup"),
	RemoteTrigger: ASK("RemoteTrigger"),
	ShowOnboardingRolePicker: ASK("ShowOnboardingRolePicker"),
	OfferChromeSetup: ASK("OfferChromeSetup"),
	ReadNotifications: ASK("ReadNotifications"),
	ProposeSkills: ASK("ProposeSkills"),
	ProposeGoal: ASK("ProposeGoal"),
	Artifact: ASK("Artifact"),
	PushNotification: ASK("PushNotification"),
	EnterWorktree: ASK("EnterWorktree"),
	ExitWorktree: ASK("ExitWorktree"),
	AskUserQuestion: "question",
	TaskCreate: "todo",
	TaskGet: "todo",
	TaskUpdate: "todo",
	TaskList: "todo",
	EnterPlanMode: "todo",
	Read: "read",
	NotebookRead: "read",
	Grep: "grep",
	Glob: "find",
	LS: "ls",
	TodoWrite: "todo",
	ToolSearch: "tool_search",
	Edit: "edit",
	MultiEdit: "edit",
	Write: "write",
	NotebookEdit: "edit",
	Bash: "bash",
	PowerShell: "powershell",
	Task: "subagent",
	Agent: "subagent",
});

// Pi Crust mode -> SDK options. EVERY chat mode runs the SDK in "default" and the decision is ours (the PreToolUse hook and canUseTool), so
// the ladder is ours and not the SDK's semantics. (The protected list does NOT ask in Trusted: permission-logic.js allows everything there, as for Pi.) No mode ever maps to the SDK's
// permission-skipping mode ("bypassPermissions") or passes its opt-in flag (allowDangerouslySkipPermissions): the SDK would then skip
// canUseTool and the "ask" of the hook. Plan is enforced by our gate too (it blocks every write and command).
const SDK_MODES = Object.freeze({
	plan: Object.freeze({ permissionMode: "default" }),
	"ask-edits": Object.freeze({ permissionMode: "default" }),
	"ask-commands": Object.freeze({ permissionMode: "default" }),
	trusted: Object.freeze({ permissionMode: "default" }),
});
// An unreadable mode gets "default" too.
const sdkModeFor = (mode) => ({ ...(SDK_MODES[logic.isMode(mode) ? mode : logic.DEFAULT_MODE]) });

// The name the shared logic should see. An unmapped name is never passed raw: "bash" or "edit" in lower case would be taken for Pi's own tools.
function logicName(toolName) {
	if (typeof toolName === "string" && Object.prototype.hasOwnProperty.call(TOOL_TABLE, toolName)) return TOOL_TABLE[toolName];
	const n = String(toolName);
	return logic.classify(n) === "command" ? n : "unknown:" + n;
}

// The fields the shared logic reads as paths (permission-logic.js PATH_KEYS). Any other path-like field (notebook_path, local_path ...)
// is copied into a free one of these, so that EVERY path of a call is judged and the strictest result wins.
const LOGIC_PATH_KEYS = ["path", "file_path", "filePath", "file", "filename"];
const EXTRA_PATH_KEY = /path|file|dir/i;
function judgedInput(toolName, input) {
	if (!input || typeof input !== "object") return input;
	const kind = logic.classify(logicName(toolName));
	if (kind !== "safe" && kind !== "edit") return input;
	const extras = Object.keys(input).filter((k) => !LOGIC_PATH_KEYS.includes(k) && EXTRA_PATH_KEY.test(k) && typeof input[k] === "string" && input[k] !== "");
	if (!extras.length) return input;
	const free = LOGIC_PATH_KEYS.filter((k) => typeof input[k] !== "string" || input[k] === "");
	if (extras.length > free.length) throw new Error("too many path fields to judge");
	const out = { ...input };
	extras.forEach((k, i) => (out[free[i]] = input[k]));
	return out;
}

// Reading a process environment (/proc/<pid>/environ) would show the API key to the agent. This is a courtesy prompt, not the defence: the
// real defence for the key is the engine's subprocess environment scrub (the key is not in the environment of what the engine runs; shown to
// work on Windows by a real run), so a rule that can be talked around only costs us an extra question, and a noisy one costs trust. Hence
// two precise rules and nothing else, and none of them in Trusted (which runs everything, as for Pi):
//   file tools (Read, Grep, Glob and every tool with a path field): normalise the path POSIX-style, expand "~", ask when the result is under
//     /proc or, for a search (Grep, Glob), is an ancestor of /proc (that is "/": "/", "/.", "/tmp/..", "~/../.." all reach it).
//     A Glob pattern is a path too, cut before its first wildcard part ("/pro*/x" is searched from "/"). Grep's pattern is a word, not a path.
//   shell commands: "/proc/" followed by "environ" once quotes and backslash escapes are removed.
const SEARCH_NAMES = new Set(["Grep", "Glob"]);
const PATH_FIELD = /path|file|dir|cwd/i;
const WILD = /[*?\[\]{}]/;
const posixPath = require("node:path").posix;
const DRIVE = /^[a-zA-Z]:/;
// The home folder for "~", POSIX-style.
function homeDir() {
	let h;
	try {
		h = require("node:os").homedir();
	} catch {}
	// a Windows drive letter is dropped: "~/../.." is then "/" there too
	return String(h || "/root").replace(/\\/g, "/").replace(/^[a-zA-Z]:(?=\/)/, "");
}
// Absolute POSIX form of a path, or null for one on a Windows drive (never /proc).
function absPosix(p, cwd) {
	let t = String(p);
	if (t === "~" || t.startsWith("~/") || t.startsWith("~\\")) t = homeDir() + t.slice(1).replace(/\\/g, "/");
	if (DRIVE.test(t)) return null;
	if (!t.startsWith("/")) {
		const base = String(cwd || "").replace(/\\/g, "/");
		if (DRIVE.test(base)) return null;
		t = (base.startsWith("/") ? base : "/" + base) + "/" + t;
	}
	return posixPath.normalize(t).replace(/\/+$/, "") || "/";
}
const underProc = (n) => n !== null && (n.toLowerCase() === "/proc" || n.toLowerCase().startsWith("/proc/"));
function procPathAsks(toolName, judged, cwd) {
	if (!judged || typeof judged !== "object") return false;
	const search = SEARCH_NAMES.has(toolName);
	const paths = [];
	for (const [k, v] of Object.entries(judged)) if (typeof v === "string" && v !== "" && PATH_FIELD.test(k)) paths.push(v);
	const roots = paths.map((p) => absPosix(p, cwd));
	if (toolName === "Glob" && typeof judged.pattern === "string" && judged.pattern !== "") {
		// The pattern is searched under the path field (or the project): cut it before its first wildcard part.
		const own = paths.length ? paths[0] : cwd;
		const pat = judged.pattern.startsWith("/") || judged.pattern.startsWith("~") || DRIVE.test(judged.pattern) ? judged.pattern : String(own || "") + "/" + judged.pattern;
		const parts = pat.split("/");
		const at = parts.findIndex((x) => WILD.test(x));
		roots.push(absPosix(at < 0 ? pat : parts.slice(0, at).join("/") || "/", cwd));
	}
	return roots.some((n) => underProc(n) || (search && n === "/"));
}
const SHELL_ENVIRON = /(?<![\w.\-])\/proc\/[^\n]*environ/i;
function readsEnviron(kind, judged, toolName, cwd) {
	if (kind === "shell") {
		const t = judged && typeof judged.command === "string" ? judged.command.replace(/\\([\s\S])/g, "$1").replace(/["'`]/g, "") : "";
		return SHELL_ENVIRON.test(t);
	}
	return (kind === "safe" || kind === "edit") && procPathAsks(toolName, judged, cwd);
}
const ENVIRON_ASK = {
	action: "ask",
	prompt: { title: "Allow reading a process environment?\nThis can show secrets such as the API key to the agent.", options: ["Allow once", "Deny"], risky: true },
	deniedReason: "Reading a process environment (/proc/.../environ) was not approved. Nothing was run.",
};

// A grant for a Bash command must not cover the same text in PowerShell: PowerShell keeps its command grants under their own prefix.
function psGrants(grants) {
	const keys = {
		has: (k) => grants.keys.has("ps:" + k),
		add: (k) => (grants.keys.add("ps:" + k), keys),
		delete: (k) => grants.keys.delete("ps:" + k),
	};
	return {
		get edits() {
			return grants.edits;
		},
		set edits(v) {
			grants.edits = v;
		},
		keys,
	};
}

// What the user reads: the plain tool name (not our internal "claude:WebFetch"), and for a subagent only what is known: starting it is what is
// approved; whether its own tool calls reach this gate is not proven, so the text does not claim they are checked.
const SUBAGENT_LINE = "Its own tools are not controlled by the permission mode.";
// A real run showed the hook sees a subagent's own calls, and they go through this gate too: each asks by itself.
const SUBAGENT_NOW = "Its own commands and edits ask separately.";
const AGENT_LABEL = "Claude Agent"; // the chat's agent label (agents/claude/index.js)
function plainPrompt(d, toolName, lname, kind) {
	if (!d.prompt || typeof d.prompt.title !== "string") return d;
	let title = d.prompt.title;
	// the tool is named "Agent" or "Task" to the SDK, but what the user approves is starting a subagent
	if (kind === "subagent") title = title.split("Allow a subagent?").join("Allow starting a subagent?").split(SUBAGENT_LINE).join(SUBAGENT_NOW);
	else if (lname !== toolName && typeof toolName === "string" && toolName) title = title.split(lname).join(toolName);
	// the shared text names Pi; this chat's agent is the Claude Agent
	title = title.split(logic.PROTECTED_WHY).join(logic.PROTECTED_WHY.replace("Pi runs", AGENT_LABEL + " runs"));
	return title === d.prompt.title ? d : { ...d, prompt: { ...d.prompt, title } };
}

const deny = (message) => ({ behavior: "deny", message: String(message || "The call was denied.") });
const FAILED = "The permission check failed, so the call was denied. Nothing was run.";
const ABORTED = "The call was cancelled before it was approved. Nothing was run.";
const NO_ANSWER = "The user did not approve this call. Nothing was run. Ask the user what to do.";

// The one decision, shared by the PreToolUse hook and canUseTool so that both see the same thing. Returns null for an answer the logic
// should never give (callers deny), else { d, lname, kind, g } where d.action is "allow", "ask" or "block".
function judge({ mode, toolName, input, grants, cwd, shell, protect }) {
	const lname = logicName(toolName);
	const kind = logic.classify(lname);
	const g = toolName === "PowerShell" ? psGrants(grants) : grants;
	const judged = judgedInput(toolName, input);
	let d = logic.decide({ mode, toolName: lname, input: judged, cwd, grants: g, protect, shell });
	if (!d || (d.action !== "allow" && d.action !== "ask" && d.action !== "block")) return null;
	if (d.action !== "block" && mode !== "trusted" && readsEnviron(kind, judged, toolName, cwd)) {
		if (mode === "plan") d = { action: "block", reason: "Plan mode is read-only and may not read a process environment (/proc/.../environ). Nothing was run." };
		else d = ENVIRON_ASK;
	}
	return { d, lname, kind, g };
}

// ask(prompt, { signal, toolName, input }) -> Promise of the chosen option text (or anything else, which denies).
//   prompt = { title, options, risky } straight from the shared logic.
// grants: this chat's grants (logic.createGrants()), kept in memory only. The adapter clears them on mode change and tab close.
// cwd: the project folder (string or function). shell/protect: optional, passed to the logic as it takes them.
// trace (optional, the trial log): trace({ phase: "final", id, tool, outcome, prompted, sub }) once per call. Names and outcomes only; a throw is ignored.
function makeCanUseTool({ getMode, ask, grants = logic.createGrants(), cwd, shell, protect, trace } = {}) {
	const val = (v) => (typeof v === "function" ? v() : v);
	async function canUseTool(toolName, input, opts) {
		const st = { prompted: false };
		const r = await decide(toolName, input, opts, st);
		if (typeof trace === "function") {
			try {
				trace({ phase: "final", id: opts && opts.toolUseID, tool: toolName, outcome: r && r.behavior === "allow" ? "allow" : "deny", prompted: st.prompted, sub: !!(opts && opts.agentID) });
			} catch {}
		}
		return r;
	}
	async function decide(toolName, input, opts, st) {
		const signal = opts && opts.signal;
		try {
			if (signal && signal.aborted) return deny(ABORTED);
			const mode = getMode();
			const j = judge({ mode, toolName, input, grants, cwd: val(cwd), shell: val(shell), protect: val(protect) });
			if (!j) return deny(FAILED);
			const { lname, kind, g } = j;
			let d = j.d;
			if (d.action === "block") return deny(d.reason);
			if (d.action === "ask") d = plainPrompt(d, toolName, lname, kind);
			let verdict = d;
			if (d.action === "ask") {
				if (typeof ask !== "function") return deny(NO_ANSWER);
				st.prompted = true;
				let onAbort;
				const aborted = new Promise((resolve) => {
					if (signal) {
						onAbort = () => resolve(ABORTED_MARK);
						signal.addEventListener("abort", onAbort, { once: true });
					}
				});
				let answer;
				try {
					answer = await Promise.race([Promise.resolve(ask(d.prompt, { signal, toolName, input })), aborted]);
				} finally {
					if (signal && onAbort) signal.removeEventListener("abort", onAbort);
				}
				if (answer === ABORTED_MARK || (signal && signal.aborted)) return deny(ABORTED);
				verdict = logic.applyAnswer(d, answer, g);
				if (verdict.action !== "allow") return deny(verdict.reason || d.deniedReason || NO_ANSWER);
			}
			// The tool runs on a copy of exactly what was judged (a hardened read-only git command replaces the command).
			const updatedInput = input && typeof input === "object" ? { ...structuredClone(input) } : {};
			if (typeof d.rewrite === "string" && verdict === d) updatedInput.command = d.rewrite;
			// A subagent never gets a looser mode than this chat; a shell command never leaves the sandbox on the model's say-so.
			if (kind === "subagent") delete updatedInput.mode;
			if (kind === "shell") delete updatedInput.dangerouslyDisableSandbox;
			// allowedPrompts could become standing approvals in the SDK that skip canUseTool.
			if (toolName === "ExitPlanMode") delete updatedInput.allowedPrompts;
			return { behavior: "allow", updatedInput };
		} catch {
			return deny(FAILED);
		}
	}
	canUseTool.grants = grants;
	return canUseTool;
}
const ABORTED_MARK = Symbol("aborted");

// The PreToolUse hook (phase 7, T3 capture section 9): the SDK approves the Agent tool and reads inside the project by itself, so canUseTool
// alone never sees them; a hook sees every call of the main loop and of subagents. This hook denies what the rules block and answers "ask"
// for everything else, which sends the call on to canUseTool, the single place that allows. It never answers "allow" and never "defer".
// Fail closed: anything unexpected (a throw, a timeout of our own code, an unknown input shape, a missing tool name) is a deny.
// The mode is the chat's (getMode), never the hook input's permission_mode; a subagent call (agent_id) is judged like the main loop's.
const HOOK_TIMEOUT_MS = 5000;
const HOOK_DENY_REASON = "The permission check failed, so the call was denied. Nothing was run.";
const hookAnswer = (decision, reason) => ({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision, ...(reason ? { permissionDecisionReason: String(reason) } : {}) } });
const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);

// trace (optional, the trial log): trace({ phase: "hook", id, tool, answer, sub }) once per call: the tool name and the answer only.
function makePreToolUseHook({ getMode, grants = logic.createGrants(), cwd, shell, protect, timeoutMs = HOOK_TIMEOUT_MS, trace } = {}) {
	const val = (v) => (typeof v === "function" ? v() : v);
	async function decideHook(input) {
		if (!isObj(input) || input.hook_event_name !== "PreToolUse") return hookAnswer("deny", HOOK_DENY_REASON);
		const toolName = input.tool_name;
		if (typeof toolName !== "string" || toolName === "" || !isObj(input.tool_input)) return hookAnswer("deny", HOOK_DENY_REASON);
		const mode = await getMode();
		if (!logic.isMode(mode)) return hookAnswer("deny", HOOK_DENY_REASON);
		const j = judge({ mode, toolName, input: input.tool_input, grants, cwd: val(cwd), shell: val(shell), protect: val(protect) });
		if (!j) return hookAnswer("deny", HOOK_DENY_REASON);
		if (j.d.action === "block") return hookAnswer("deny", j.d.reason || HOOK_DENY_REASON);
		return hookAnswer("ask");
	}
	return async function preToolUseHook(input) {
		let timer;
		let res;
		try {
			const timeout = new Promise((resolve) => (timer = setTimeout(() => resolve(hookAnswer("deny", HOOK_DENY_REASON)), timeoutMs)));
			res = await Promise.race([decideHook(input), timeout]);
		} catch {
			res = hookAnswer("deny", HOOK_DENY_REASON);
		} finally {
			clearTimeout(timer);
		}
		if (typeof trace === "function") {
			try {
				const o = isObj(input) ? input : {};
				trace({ phase: "hook", id: o.tool_use_id, tool: o.tool_name, answer: res.hookSpecificOutput.permissionDecision, sub: typeof o.agent_id === "string" && o.agent_id !== "" });
			} catch {}
		}
		return res;
	};
}

// options.hooks for the SDK: one matcher without a pattern (matches every tool) and onFailure "block", so a failure of the hook machinery
// itself blocks the call instead of letting it go ahead. The timeout (seconds) is the SDK's, ours is shorter.
function makeHooks(opts = {}) {
	return { PreToolUse: [{ hooks: [makePreToolUseHook(opts)], timeout: 30, onFailure: "block" }] };
}

module.exports = { TOOL_TABLE, SDK_MODES, sdkModeFor, logicName, makeCanUseTool, makePreToolUseHook, makeHooks, judge };
