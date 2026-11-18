// Permissions for the Claude agent. Pure: no Electron, no SDK import. The decisions come from the shared logic (src/permission-logic.js,
// the same one Pi's extension uses); this file only maps Claude's names onto it and shapes the answers the SDK wants.
// Fail closed everywhere: an unknown tool asks; an answer that is not exactly an offered "Allow" option, a thrown error and an
// aborted signal all deny. We never return updatedPermissions (it would persist an "always allow" outside our control).
"use strict";

const logic = require("../../permission-logic");

// Claude's tool names -> the names permission-logic.js knows (its categories: safe, edit, shell, subagent; anything else is a command).
// Exact, case-sensitive. A name that is not here is unknown and asks, see logicName().
const TOOL_TABLE = Object.freeze({
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

// Pi Crust mode -> SDK options. Ask before edits and Ask before commands both run the SDK in "default" and decide here, so the ladder
// is ours and not the SDK's acceptEdits semantics (plan section 3.5, the recommended route). Trusted needs the extra opt-in flag.
const SDK_MODES = Object.freeze({
	plan: Object.freeze({ permissionMode: "plan" }),
	"ask-edits": Object.freeze({ permissionMode: "default" }),
	"ask-commands": Object.freeze({ permissionMode: "default" }),
	trusted: Object.freeze({ permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true }),
});
// An unreadable mode gets "default", never the skip-all mode.
const sdkModeFor = (mode) => ({ ...(SDK_MODES[logic.isMode(mode) ? mode : logic.DEFAULT_MODE]) });

// The name the shared logic should see. An unmapped name is never passed raw: "bash" or "edit" in lower case would be taken for Pi's own tools.
function logicName(toolName) {
	if (typeof toolName === "string" && Object.prototype.hasOwnProperty.call(TOOL_TABLE, toolName)) return TOOL_TABLE[toolName];
	const n = String(toolName);
	return logic.classify(n) === "command" ? n : "unknown:" + n;
}

// The input as the logic should read it: NotebookEdit names its file notebook_path, which the logic does not look at.
function judgedInput(toolName, input) {
	if (!input || typeof input !== "object") return input;
	if (toolName === "NotebookEdit" && input.path === undefined && input.file_path === undefined && input.notebook_path !== undefined) return { ...input, path: input.notebook_path };
	return input;
}

const deny = (message) => ({ behavior: "deny", message: String(message || "The call was denied.") });
const FAILED = "The permission check failed, so the call was denied. Nothing was run.";
const ABORTED = "The call was cancelled before it was approved. Nothing was run.";
const NO_ANSWER = "The user did not approve this call. Nothing was run. Ask the user what to do.";

// ask(prompt, { signal, toolName, input }) -> Promise of the chosen option text (or anything else, which denies).
//   prompt = { title, options, risky } straight from the shared logic.
// grants: this chat's grants (logic.createGrants()), kept in memory only. The adapter clears them on mode change and tab close.
// cwd: the project folder (string or function). shell/protect: optional, passed to the logic as it takes them.
function makeCanUseTool({ getMode, ask, grants = logic.createGrants(), cwd, shell, protect } = {}) {
	const val = (v) => (typeof v === "function" ? v() : v);
	async function canUseTool(toolName, input, opts) {
		const signal = opts && opts.signal;
		try {
			if (signal && signal.aborted) return deny(ABORTED);
			const d = logic.decide({ mode: getMode(), toolName: logicName(toolName), input: judgedInput(toolName, input), cwd: val(cwd), grants, protect: val(protect), shell: val(shell) });
			if (!d || (d.action !== "allow" && d.action !== "ask" && d.action !== "block")) return deny(FAILED);
			if (d.action === "block") return deny(d.reason);
			let verdict = d;
			if (d.action === "ask") {
				if (typeof ask !== "function") return deny(NO_ANSWER);
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
				verdict = logic.applyAnswer(d, answer, grants);
				if (verdict.action !== "allow") return deny(verdict.reason || d.deniedReason || NO_ANSWER);
			}
			// The tool runs on a copy of exactly what was judged (a hardened read-only git command replaces the command).
			const updatedInput = input && typeof input === "object" ? { ...structuredClone(input) } : {};
			if (typeof d.rewrite === "string" && verdict === d) updatedInput.command = d.rewrite;
			return { behavior: "allow", updatedInput };
		} catch {
			return deny(FAILED);
		}
	}
	canUseTool.grants = grants;
	return canUseTool;
}
const ABORTED_MARK = Symbol("aborted");

module.exports = { TOOL_TABLE, SDK_MODES, sdkModeFor, logicName, makeCanUseTool };
