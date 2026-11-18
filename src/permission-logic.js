// Permission-mode decisions (used by pi-extension/permission-modes.ts). Pure: no Pi, no Electron, no UI.
// decide({ mode, toolName, input, cwd, grants }) -> { action: "allow" | "ask" | "block", reason?, prompt?, grant? }
// Fail closed: anything unknown, unparsable or thrown is a block (or an ask), never an allow.
// Modes are a safety net in front of tools, not a sandbox.
"use strict";

const fs = require("fs");
const os = require("os");
const nodePath = require("path");

// ---------------------------------------------------------------------------
// Modes (ids and labels must match src/palette.js and src/remote-state.js)
// ---------------------------------------------------------------------------
const MODE_IDS = ["plan", "ask-edits", "ask-commands", "trusted"];
const MODE_LABELS = { plan: "Plan (read-only)", "ask-edits": "Ask before edits", "ask-commands": "Ask before commands", trusted: "Trusted" };
const DEFAULT_MODE = "ask-commands";
const STATUS_KEY = "permission-mode";
const ENTRY_TYPE = "crust-permission-mode";

const isMode = (m) => typeof m === "string" && Object.prototype.hasOwnProperty.call(MODE_LABELS, m);
const statusText = (mode) => `Mode: ${MODE_LABELS[isMode(mode) ? mode : DEFAULT_MODE]}`;
// "/mode <arg>": exact ids only (case and surrounding space ignored). null = not a mode.
function parseMode(arg) {
	const a = String(arg ?? "").trim().toLowerCase();
	return isMode(a) ? a : null;
}
// The mode saved in a session: last custom entry of ours. No entry -> null (caller uses the last chosen / default).
// An entry that cannot be read -> Ask before commands, never Trusted.
function restoreMode(entries) {
	try {
		if (!Array.isArray(entries)) return DEFAULT_MODE;
		for (let i = entries.length - 1; i >= 0; i--) {
			const e = entries[i];
			if (e && e.type === "custom" && e.customType === ENTRY_TYPE) return e.data && isMode(e.data.mode) ? e.data.mode : DEFAULT_MODE;
		}
		return null;
	} catch {
		return DEFAULT_MODE;
	}
}
// The "last chosen" file content: {"mode": "<id>"}. Anything else -> default.
function parseLastMode(text) {
	try {
		const m = JSON.parse(String(text)).mode;
		return isMode(m) ? m : DEFAULT_MODE;
	} catch {
		return DEFAULT_MODE;
	}
}

// ---------------------------------------------------------------------------
// Grants ("Allow for this chat"): in-memory, cleared on mode change by the caller.
//   edits: every edit inside the project.  keys: exact command / exact outside path / exact subagent call.
// ---------------------------------------------------------------------------
function createGrants() {
	return { edits: false, keys: new Set() };
}
function clearGrants(g) {
	g.edits = false;
	g.keys.clear();
}

// ---------------------------------------------------------------------------
// Tool classes
// ---------------------------------------------------------------------------
const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
const EDIT_TOOLS = new Set(["edit", "write"]);
const SHELL_TOOLS = new Set(["bash", "powershell"]);
const HARMLESS_TOOLS = new Set(["todo", "question", "tool_search", "advisor"]);
function classify(toolName) {
	const n = String(toolName).toLowerCase();
	if (READ_TOOLS.has(n) || HARMLESS_TOOLS.has(n)) return "safe";
	if (EDIT_TOOLS.has(n)) return "edit";
	if (SHELL_TOOLS.has(n)) return "shell";
	if (n === "subagent") return "subagent";
	return "command"; // unknown tools and MCP tools count as commands
}

// ---------------------------------------------------------------------------
// Paths: is a path inside the project folder?
// ---------------------------------------------------------------------------
// Returns { inside, resolved }. Anything odd (not a string, NUL, UNC to another share, device paths,
// drive-relative "C:foo", unreadable) is outside. Inside needs BOTH the lexical path and the real path
// (symlinks and junctions followed on the deepest existing part) to be inside the real project folder.
function checkPath(rawPath, cwd, opts = {}) {
	const r = checkOne(rawPath, cwd, opts);
	// A leading @ is dropped by some tools and kept by others: both readings must be inside.
	if (r.inside && typeof rawPath === "string" && rawPath.trim().startsWith("@")) {
		const r2 = checkOne(rawPath.trim().slice(1), cwd, opts);
		if (!r2.inside) return r2;
	}
	return r;
}
function checkOne(rawPath, cwd, opts) {
	const platform = opts.platform || process.platform;
	const win = platform === "win32";
	const P = win ? nodePath.win32 : nodePath.posix;
	const realpath = opts.realpath || ((p) => fs.realpathSync.native(p));
	const home = opts.home || os.homedir();
	const outside = (resolved) => ({ inside: false, resolved: resolved || String(rawPath) });
	try {
		if (typeof rawPath !== "string" || rawPath === "" || rawPath.includes("\0")) return outside();
		if (typeof cwd !== "string" || cwd === "" || cwd.includes("\0")) return outside();
		let raw = rawPath.trim();
		if (raw === "~" || /^~[\\/]/.test(raw)) raw = P.join(home, raw.slice(1));
		if (win) {
			if (/^[\\/]{2}\?[\\/][a-zA-Z]:[\\/]/.test(raw)) raw = raw.slice(4); // \\?\C:\x -> C:\x
			if (/^[\\/]{2}[.?][\\/]/.test(raw)) return outside(); // device, \\?\UNC\ and other extended paths
			if (/^[\\/]{2}[^\\/]/.test(raw)) return outside(); // UNC
			if (/^[a-zA-Z]:(?![\\/])/.test(raw)) return outside(); // drive-relative: C:foo
			raw = raw.replace(/\//g, "\\");
		}
		const base = P.resolve(cwd);
		const abs = P.resolve(base, raw);
		if (win && /^[\\/]{2}/.test(abs)) return outside(abs);
		const key = (p) => (win ? p.toLowerCase() : p);
		const within = (child, parent) => {
			const c = key(child);
			const p = key(parent).replace(/[\\/]+$/, "");
			return c === p || c.startsWith(p + P.sep);
		};
		const real = (p) => {
			// real path of the deepest existing ancestor + the rest
			let cur = p;
			const rest = [];
			for (let i = 0; i < 4096; i++) {
				try {
					return P.join(realpath(cur), ...rest.reverse());
				} catch (e) {
					const parent = P.dirname(cur);
					if (parent === cur) throw e;
					rest.push(P.basename(cur));
					cur = parent;
				}
			}
			throw new Error("path too deep");
		};
		const realBase = real(base);
		const realAbs = real(abs);
		const inside = (within(abs, base) || within(abs, realBase)) && within(realAbs, realBase);
		return { inside, resolved: realAbs };
	} catch {
		return outside();
	}
}

// The path an edit-class tool targets, or null.
function editPathOf(input) {
	if (!input || typeof input !== "object") return null;
	for (const k of ["path", "file_path", "filePath", "file", "filename"]) if (typeof input[k] === "string" && input[k] !== "") return input[k];
	return null;
}

// ---------------------------------------------------------------------------
// Read-only shell commands
// ---------------------------------------------------------------------------
// A command is read-only only if the WHOLE line is one allowlisted command with safe arguments.
// Rejected outright (even inside quotes): ; & | < > ` $ ( ) { } @ ^ ! newline and other control characters.
// That removes pipes, chains, redirects, subshells, substitutions, PowerShell splatting and blocks.
const FORBIDDEN_CHARS = /[;&|<>`$(){}@^!\x00-\x08\x0a-\x1f\x7f]/;
const MAX_COMMAND = 2000;

// Split on spaces/tabs outside quotes. Returns null for unbalanced quotes.
function tokenize(line) {
	const tokens = [];
	let cur = "";
	let started = false;
	let quote = null;
	for (const ch of line) {
		if (quote) {
			if (ch === quote) quote = null;
			cur += ch;
		} else if (ch === "'" || ch === '"') {
			quote = ch;
			started = true;
			cur += ch;
		} else if (ch === " " || ch === "\t") {
			if (started) tokens.push(cur);
			cur = "";
			started = false;
		} else {
			cur += ch;
			started = true;
		}
	}
	if (quote) return null;
	if (started) tokens.push(cur);
	return tokens;
}
// What the shell will see after removing quotes and escapes (used for flag checks).
const effective = (tok) => tok.replace(/["'\\]/g, "");

const GIT_SUBS = new Set(["status", "diff", "log", "show", "ls-files", "rev-parse", "blame", "describe"]);
// git accepts unique abbreviations of long options, so forbid every prefix (>= "--o") of these.
const GIT_FORBIDDEN_LONG = ["--output", "--ext-diff", "--textconv", "--open-files-in-pager"];
const denyRe = (re) => (args) => !args.some((a) => re.test(a));
const FIND_DENY = /^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/i;

// name -> function(args after effective()) -> true when the arguments are safe
const READ_ONLY_COMMANDS = {
	pwd: () => true,
	ls: () => true,
	dir: () => true,
	cat: () => true,
	type: () => true,
	head: () => true,
	wc: () => true,
	which: () => true,
	where: () => true,
	grep: () => true,
	tail: (args) => !args.some((a) => /^--f/i.test(a) || /^-[^-]*f/i.test(a)), // no follow (never ends)
	find: (args) => !args.some((a) => FIND_DENY.test(a)),
	rg: (args) => !args.some((a) => /^--(pre|hostname)/i.test(a) || /^--search-zip/i.test(a) || /^-[^-]*z/.test(a)), // --pre runs a program
	git: (args) => {
		if (!args.length || !GIT_SUBS.has(args[0])) return false; // also rejects -c, -C, --exec-path ... before the subcommand
		return !args.slice(1).some((a) => {
			if (!a.startsWith("--")) return false;
			const name = a.split("=")[0].toLowerCase();
			return GIT_FORBIDDEN_LONG.some((f) => name.length >= 3 && (f.startsWith(name) || name.startsWith(f)));
		});
	},
	"get-location": () => true,
	"get-childitem": () => true,
	"get-item": () => true,
	"select-string": () => true,
	"get-content": denyRe(/^-w/i), // -Wait never ends
};
const READ_ONLY_NAMES = Object.keys(READ_ONLY_COMMANDS);

function isReadOnlyCommand(command) {
	try {
		if (typeof command !== "string") return false;
		const line = command.trim();
		if (!line || line.length > MAX_COMMAND) return false;
		if (FORBIDDEN_CHARS.test(line)) return false;
		const tokens = tokenize(line);
		if (!tokens || !tokens.length) return false;
		const name = tokens[0].toLowerCase();
		if (!Object.prototype.hasOwnProperty.call(READ_ONLY_COMMANDS, name)) return false; // raw token: no quotes, escapes or VAR=x prefix
		return READ_ONLY_COMMANDS[name](tokens.slice(1).map(effective)) === true;
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Texts
// ---------------------------------------------------------------------------
const OPTIONS = ["Allow once", "Allow for this chat", "Deny"];
const clip = (s, n = 300) => {
	const t = String(s ?? "").replace(/[\x00-\x1f\x7f]+/g, " ").trim();
	return t.length > n ? t.slice(0, n - 1) + "\u2026" : t;
};
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function planBlock(what) {
	return `Plan mode is read-only. ${what} is not allowed. Describe the change as a plan and ask the user to switch to another mode if it should be carried out.`;
}
const DENIED = (what) => `The user denied this ${what}. Don't try it again or another way around it. Ask the user what to do.`;

function askEdit(mode, toolName, shown, outsideProject) {
	return `${outsideProject ? "Allow this edit OUTSIDE the project folder?" : "Allow this edit?"}\n${cap(String(toolName))}  ${clip(shown)}\n${statusText(mode)}`;
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------
const allow = () => ({ action: "allow" });
const block = (reason) => ({ action: "block", reason });
const ask = (title, grant, deniedWhat) => ({ action: "ask", prompt: { title, options: OPTIONS.slice() }, grant, deniedReason: DENIED(deniedWhat) });

function decide(args) {
	try {
		const { mode, toolName, input, cwd } = args || {};
		const grants = (args && args.grants) || createGrants();
		if (!isMode(mode)) return block("Permission mode is unreadable, so the call was blocked. Ask the user to pick a mode again.");
		if (typeof toolName !== "string" || toolName === "") return block("The tool call has no readable tool name, so it was blocked.");
		const kind = classify(toolName);
		const pathOpts = args.pathOptions || {};
		if (kind === "safe") return allow();
		if (mode === "trusted") return allow();

		if (kind === "edit") {
			if (mode === "plan") return block(planBlock("Editing files"));
			const target = editPathOf(input);
			const where = target === null ? { inside: false, resolved: "(no path)" } : checkPath(target, cwd, pathOpts);
			const shown = target === null ? "(no path given)" : target;
			if (where.inside) {
				if (mode === "ask-commands" || grants.edits) return allow();
				return ask(askEdit(mode, toolName, shown, false), { type: "edits" }, "edit");
			}
			const key = "path:" + (process.platform === "win32" || (pathOpts.platform === "win32") ? where.resolved.toLowerCase() : where.resolved);
			if (grants.keys.has(key)) return allow();
			return ask(askEdit(mode, toolName, shown, true), { type: "key", key }, "edit");
		}

		if (kind === "shell") {
			const command = input && typeof input === "object" ? input.command : undefined;
			if (isReadOnlyCommand(command)) return allow();
			if (mode === "plan") return block(planBlock("This command") + " Only read-only commands run in Plan mode.");
			if (typeof command !== "string" || command.trim() === "") return block("The command is empty or unreadable, so it was blocked.");
			const key = "cmd:" + command;
			if (grants.keys.has(key)) return allow();
			return ask(`Allow this command?\n${clip(command)}\n${statusText(mode)}`, { type: "key", key }, "command");
		}

		if (kind === "subagent") {
			if (mode === "plan") return block(planBlock("A subagent") + " A subagent runs as a separate Pi that does not follow the mode.");
			const task = input && typeof input === "object" ? (input.task ?? input.prompt ?? input.description ?? "") : "";
			const key = "sub:" + stable(input);
			if (grants.keys.has(key)) return allow();
			const head = task ? `Task: ${clip(task)}\n` : "";
			return ask(`Allow a subagent?\n${head}Its own tools are not controlled by the permission mode.\n${statusText(mode)}`, { type: "key", key }, "subagent");
		}

		// unknown tools and MCP tools: treated as commands
		if (mode === "plan") return block(planBlock(`The tool "${clip(toolName, 80)}"`) + " Unknown and MCP tools count as commands.");
		const key = "tool:" + toolName + ":" + stable(input);
		if (grants.keys.has(key)) return allow();
		return ask(`Allow this tool call?\n${clip(toolName, 80)}  ${clip(stable(input))}\n${statusText(mode)}`, { type: "key", key }, "tool call");
	} catch {
		return block("The permission check failed, so the call was blocked.");
	}
}

function stable(v) {
	if (v === undefined) return "undefined";
	if (v === null || typeof v !== "object") return JSON.stringify(v);
	if (Array.isArray(v)) return "[" + v.map(stable).join(",") + "]";
	return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + stable(v[k])).join(",") + "}";
}

// Turns the user's answer to an "ask" decision into allow / block. Only the exact option text allows;
// undefined, Cancel, Esc, timeouts and anything else deny.
function applyAnswer(decision, answer, grants) {
	try {
		if (decision && decision.action === "ask" && (answer === OPTIONS[0] || answer === OPTIONS[1])) {
			if (answer === OPTIONS[1] && grants && decision.grant) {
				if (decision.grant.type === "edits") grants.edits = true;
				else if (decision.grant.type === "key") grants.keys.add(decision.grant.key);
			}
			return allow();
		}
		return block((decision && decision.deniedReason) || DENIED("call"));
	} catch {
		return block("The permission check failed, so the call was blocked.");
	}
}

module.exports = {
	MODE_IDS, MODE_LABELS, DEFAULT_MODE, STATUS_KEY, ENTRY_TYPE, OPTIONS, READ_ONLY_NAMES,
	isMode, statusText, parseMode, restoreMode, parseLastMode,
	createGrants, clearGrants, classify, checkPath, editPathOf, isReadOnlyCommand, decide, applyAnswer,
};
