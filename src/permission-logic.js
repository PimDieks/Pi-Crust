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
// The app sends "/crust-mode <id>": unlike "/mode" it cannot clash with another extension's /mode command.
const COMMAND_NAMES = ["mode", "crust-mode"];

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
//   edits: every edit inside the project (never the protected list).  keys: exact command / exact outside path / exact subagent call.
// ---------------------------------------------------------------------------
function createGrants() {
	return { edits: false, keys: new Set() };
}
function clearGrants(g) {
	g.edits = false;
	g.keys.clear();
}

// ---------------------------------------------------------------------------
// Tool classes (exact, case-sensitive names: Pi's built-in tools are lower case)
// ---------------------------------------------------------------------------
const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
const EDIT_TOOLS = new Set(["edit", "write"]);
const SHELL_TOOLS = new Set(["bash", "powershell"]);
const HARMLESS_TOOLS = new Set(["todo", "question", "tool_search", "advisor"]);
function classify(toolName) {
	const n = String(toolName);
	if (READ_TOOLS.has(n) || HARMLESS_TOOLS.has(n)) return "safe";
	if (EDIT_TOOLS.has(n)) return "edit";
	if (SHELL_TOOLS.has(n)) return "shell";
	if (n === "subagent") return "subagent";
	return "command"; // unknown tools and MCP tools count as commands
}

// ---------------------------------------------------------------------------
// Paths: is a path inside the project folder? Judged the way Pi resolves it (dist/utils/paths.js resolvePath).
// ---------------------------------------------------------------------------
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
const PATH_KEYS = ["path", "file_path", "filePath", "file", "filename"];

// Names whose contents decide what git or Pi will RUN (hooks, fsmonitor, diff drivers, session dir, extensions ...).
// Judged on every component of the resolved path, with NTFS tricks removed (trailing dots/spaces, :streams, 8.3 short names).
function protectedName(comp) {
	const c = String(comp).split(":")[0].replace(/[. ]+$/, "").toLowerCase();
	return c === ".git" || c === ".pi" || c === ".gitattributes" || c === ".gitmodules" || /^git\w*~\d+$/.test(c);
}
const PROTECTED_WHY = "This file can change what git or Pi runs.";

// Pi's own rewrite of /c/x, /mnt/c/x and /cygdrive/c/x to C:\x (win32 only).
function shellDrivePath(p) {
	if (!p.startsWith("/") || p.startsWith("//") || p.includes("\\")) return p;
	const m = p.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
	if (!m) return p;
	return `${m[1].toUpperCase()}:\\${(m[2] || "").replace(/\//g, "\\")}`;
}

// Returns { inside, resolved, unc, protected, broad }. Anything odd (not a string, NUL, UNC / network, device paths,
// other URL schemes, drive-relative "C:foo", unreadable) is outside. Inside needs BOTH the lexical path and the real path
// (symlinks and junctions followed on the deepest existing part) to be inside the real project folder, and the
// project folder must not be the home folder, one of its parents or a drive root.
// Every way Pi may read the text is tried (as is, trimmed, Unicode spaces, leading @ dropped): the worst one counts.
function checkPath(rawPath, cwd, opts = {}) {
	if (typeof rawPath !== "string") return { inside: false, resolved: String(rawPath), unc: false, protected: false };
	const variants = new Set([rawPath, rawPath.trim(), rawPath.replace(UNICODE_SPACES, " "), rawPath.replace(UNICODE_SPACES, " ").trim()]);
	for (const v of [...variants]) if (v.trim().startsWith("@")) variants.add(v.trim().slice(1));
	let out = null;
	for (const v of variants) {
		const r = checkOne(v, cwd, opts);
		if (!out) out = { ...r };
		else {
			if (out.inside && !r.inside) {
				out.inside = false;
				out.resolved = r.resolved;
			}
			out.unc = out.unc || r.unc;
			out.protected = out.protected || r.protected;
			out.broad = out.broad || r.broad;
		}
	}
	return out;
}
function checkOne(rawPath, cwd, opts) {
	const platform = opts.platform || process.platform;
	const win = platform === "win32";
	const P = win ? nodePath.win32 : nodePath.posix;
	const realpath = opts.realpath || ((p) => fs.realpathSync.native(p));
	const home = opts.home || os.homedir();
	const agentDir = opts.agentDir || process.env.PI_CODING_AGENT_DIR || P.join(home, ".pi", "agent");
	const res = (o) => ({ inside: false, resolved: String(rawPath), unc: false, protected: false, broad: false, ...o });
	try {
		if (typeof rawPath !== "string" || rawPath === "" || rawPath.includes("\0")) return res({});
		if (typeof cwd !== "string" || cwd === "" || cwd.includes("\0")) return res({});
		let raw = rawPath.trim();
		if (win) raw = shellDrivePath(raw);
		if (raw === "~" || /^~[\\/]/.test(raw)) raw = P.join(home, raw.slice(1));
		if (/^file:\/\//.test(raw)) {
			// Pi turns file:// URLs into real paths (a host name becomes a network share).
			const u = new URL(raw);
			if (/%(2f|5c)/i.test(u.pathname)) return res({});
			let p = decodeURIComponent(u.pathname);
			if (u.hostname) return res({ unc: true });
			if (win) {
				if (/^\/[a-zA-Z]:/.test(p)) p = p.slice(1);
				p = p.replace(/\//g, "\\");
			}
			raw = p;
		} else if (/^[a-zA-Z]{2,}:/.test(raw)) {
			return res({}); // any other scheme (http:, ftp:, FILE: ...) is not a plain path
		}
		if (win) {
			if (/^[\\/]{2}\?[\\/][a-zA-Z]:[\\/]/.test(raw)) raw = raw.slice(4); // \\?\C:\x -> C:\x
			if (/^[\\/]{2}[.?][\\/]/.test(raw)) return res({ unc: true }); // device, \\?\UNC\ and other extended paths
			if (/^[\\/]{2}[^\\/]/.test(raw)) return res({ unc: true }); // UNC (also //host/share)
			if (/^[a-zA-Z]:(?![\\/])/.test(raw)) return res({}); // drive-relative: C:foo
			raw = raw.replace(/\//g, "\\");
		}
		const base = P.resolve(cwd);
		const abs = P.resolve(base, raw);
		if (win && /^[\\/]{2}/.test(abs)) return res({ resolved: abs, unc: true });
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
		if (win && /^[\\/]{2}/.test(realAbs)) return res({ resolved: realAbs, unc: true });
		// A project that is the home folder, a parent of it or a drive root would make everything "inside".
		const root = P.parse(realBase).root;
		let realHome = home;
		try {
			realHome = real(home);
		} catch {}
		const broad = key(realBase).replace(/[\\/]+$/, "") === key(root).replace(/[\\/]+$/, "") || within(realHome, realBase) || within(home, base);
		const inside = !broad && (within(abs, base) || within(abs, realBase)) && within(realAbs, realBase);
		// Protected list: judged on the lexical and on the real path.
		let prot = false;
		for (const [p, b] of [[abs, base], [realAbs, realBase]]) {
			const rel = within(p, b) ? P.relative(b, p) : null;
			if (rel !== null && rel !== "") {
				const comps = rel.split(/[\\/]+/).filter(Boolean);
				if (comps.some(protectedName)) prot = true;
				if (comps.length === 1 && key(comps[0]) === key("HEAD")) prot = true; // root-level HEAD (a bare repository)
			}
			if (!inside) {
				if (p.split(/[\\/]+/).filter(Boolean).some(protectedName)) prot = true;
				if (within(p, agentDir)) prot = true; // Pi's own config, sessions and extensions
				if (within(p, home) && P.relative(home, p).split(/[\\/]+/).filter(Boolean).length === 1 && P.basename(p).startsWith(".")) prot = true; // ~/.gitconfig, ~/.bashrc ...
			}
		}
		return { inside, resolved: realAbs, unc: false, protected: prot, broad };
	} catch {
		return res({});
	}
}

// The path an edit-class tool targets, or null.
function editPathOf(input) {
	return editPathsOf(input)[0] ?? null;
}
// Every path-like field of the input. All of them are judged, so a second field cannot hide a different target.
function editPathsOf(input) {
	if (!input || typeof input !== "object") return [];
	const out = [];
	for (const k of PATH_KEYS) if (typeof input[k] === "string" && input[k] !== "") out.push(input[k]);
	return out;
}
// Path-like arguments of the read tools (read, grep, find, ls).
function readPathsOf(input) {
	if (!input || typeof input !== "object") return [];
	const out = [];
	for (const k of [...PATH_KEYS, "cwd", "dir", "directory"]) if (typeof input[k] === "string" && input[k] !== "") out.push(input[k]);
	return out;
}

// ---------------------------------------------------------------------------
// Read-only shell commands
// ---------------------------------------------------------------------------
// A command is read-only only if the WHOLE line is one allowlisted command with safe arguments.
// Rejected outright (even inside quotes): ; & | < > ` $ ( ) { } @ ^ ! * ? [ newline and other control characters.
// That removes pipes, chains, redirects, subshells, substitutions, PowerShell splatting and blocks, and every glob:
// a glob can turn a file name such as "-delete" into an option AFTER this check, so nothing may expand.
// Also rejected: arguments starting with ~ or #, network paths (\\host, //host, scheme://) and PowerShell providers (Env:, HKCU: ...).
const FORBIDDEN_CHARS = /[;&|<>`$(){}@^!*?[\x00-\x08\x0a-\x1f\x7f]/;
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
// An argument that names a network location, or a PowerShell provider that is not the file system.
const NETWORK_ARG = /(^|[^A-Za-z0-9_.\-])[\\/]{2}|:\/\//;
const PROVIDER_ARG = /^(env|hklm|hkcu|hkcr|hku|variable|function|alias|cert|wsman):/i;
const badArg = (rawTok) => {
	const noQuotes = rawTok.replace(/["']/g, "");
	const eff = effective(rawTok);
	return NETWORK_ARG.test(noQuotes) || NETWORK_ARG.test(eff) || /^[~#]/.test(eff) || PROVIDER_ARG.test(eff);
};

const GIT_SUBS = new Set(["status", "diff", "log", "show", "ls-files", "rev-parse", "blame", "describe"]);
// git accepts unique abbreviations of long options, so forbid every prefix (>= "--o") of these.
const GIT_FORBIDDEN_LONG = ["--output", "--ext-diff", "--textconv", "--open-files-in-pager"];
const denyRe = (re) => (args) => !args.some((a) => re.test(a));
const FIND_DENY = /^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/i;
const DASH = "[-\\u2013\\u2014\\u2015]"; // PowerShell reads en and em dashes as "-"
const NO_WAIT = denyRe(new RegExp(`^${DASH}w`, "i")); // -Wait never ends

// name -> function(args after effective()) -> true when the arguments are safe
const READ_ONLY_COMMANDS = {
	pwd: () => true,
	ls: () => true,
	dir: () => true,
	cat: NO_WAIT,
	type: NO_WAIT,
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
	"get-content": NO_WAIT,
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
		const rest = tokens.slice(1);
		if (rest.some(badArg)) return false;
		return READ_ONLY_COMMANDS[name](rest.map(effective)) === true;
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Texts: what the user is shown must be what runs
// ---------------------------------------------------------------------------
const OPTIONS = ["Allow once", "Allow for this chat", "Deny"];
const OPTIONS_ONCE = ["Allow once", "Deny"]; // no "for this chat": protected files, network paths, text that is not fully shown
const MAX_SHOWN = 600; // longest command or path shown in full; longer ones are refused (phones cut titles at 1500)

// Makes invisible and look-alike characters visible, and long whitespace runs obvious.
function vis(s) {
	let t = String(s ?? "");
	t = t.replace(/[ \t]{3,}/g, (m) => `\u27e8${m.length} spaces\u27e9`);
	t = t.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cs}\p{Cn}\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000\u115F\u1160\u3164\uFFA0\u2800\u180E\uFE00-\uFE0F]/gu, (ch) => {
		if (ch === "\n") return "\u27e8LF\u27e9";
		if (ch === "\r") return "\u27e8CR\u27e9";
		if (ch === "\t") return "\u27e8TAB\u27e9";
		return `\u27e8U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}\u27e9`;
	});
	return t;
}
// Short text for details that do not run (a subagent task, a tool name): head and tail plus the hidden count.
function brief(s, n = 300) {
	const t = vis(s).trim();
	if (t.length <= n) return t;
	const head = Math.ceil(n * 0.6);
	const tail = n - head;
	return `${t.slice(0, head)} \u27e8${t.length - n} more characters not shown\u27e9 ${t.slice(t.length - tail)}`;
}
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const tooLong = (what, n) => `This ${what} is ${n} characters long, too long to show in full for approval, so it was blocked. Use a shorter one, or ask the user to switch to Trusted.`;

function planBlock(what) {
	return `Plan mode is read-only. ${what} is not allowed. Describe the change as a plan and ask the user to switch to another mode if it should be carried out.`;
}
const DENIED = (what) => `The user denied this ${what}. Don't try it again or another way around it. Ask the user what to do.`;

function askEdit(mode, toolName, shown, resolved, flags) {
	const head = flags.outside ? "Allow this edit OUTSIDE the project folder?" : "Allow this edit?";
	const lines = [head];
	if (flags.protected) lines.push(PROTECTED_WHY);
	if (flags.unc) lines.push("This is a network path.");
	if (flags.broad) lines.push("The project folder is your home folder or a drive root, so every edit asks.");
	shown.forEach((s, i) => {
		lines.push(`${i === 0 ? cap(String(toolName)) : "Also"}  ${vis(s)}`);
		if (resolved[i] && vis(resolved[i]).toLowerCase() !== vis(s).toLowerCase() && vis(resolved[i]) !== vis(s).replace(/\//g, "\\")) lines.push(`Resolves to  ${vis(resolved[i])}`);
	});
	lines.push(statusText(mode));
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------
const allow = () => ({ action: "allow" });
const block = (reason) => ({ action: "block", reason });
const ask = (title, grant, deniedWhat, options) => ({ action: "ask", prompt: { title, options: (options || OPTIONS).slice() }, grant, deniedReason: DENIED(deniedWhat) });
const askOnce = (title, deniedWhat) => ask(title, undefined, deniedWhat, OPTIONS_ONCE);

function decide(args) {
	try {
		const { mode, toolName, input, cwd } = args || {};
		const grants = (args && args.grants) || createGrants();
		if (!isMode(mode)) return block("Permission mode is unreadable, so the call was blocked. Ask the user to pick a mode again.");
		if (typeof toolName !== "string" || toolName === "") return block("The tool call has no readable tool name, so it was blocked.");
		const kind = classify(toolName);
		const pathOpts = args.pathOptions || {};
		if (kind === "safe") {
			// Reads of network paths (\\host, //host, file://host) send credentials or names off the machine.
			if (mode !== "trusted" && READ_TOOLS.has(toolName)) {
				const hit = readPathsOf(input).find((p) => checkPath(p, cwd, pathOpts).unc);
				if (hit !== undefined) {
					if (mode === "plan") return block(planBlock("Reading a network path") + " Nothing may leave the machine in Plan mode.");
					return askOnce(`Allow reading a network path?\n${toolName}  ${brief(hit, MAX_SHOWN)}\nThe computer may send your sign-in or the name to that host.\n${statusText(mode)}`, "read");
				}
			}
			return allow();
		}
		if (mode === "trusted") return allow();

		if (kind === "edit") {
			if (mode === "plan") return block(planBlock("Editing files"));
			const targets = editPathsOf(input);
			if (!targets.length) return block("The edit has no readable file path, so it was blocked. Use the path field.");
			const wheres = targets.map((t) => checkPath(t, cwd, pathOpts));
			if (targets.some((t) => vis(t).length > MAX_SHOWN)) return block(tooLong("file path", Math.max(...targets.map((t) => vis(t).length))));
			const flags = { outside: wheres.some((w) => !w.inside), protected: wheres.some((w) => w.protected), unc: wheres.some((w) => w.unc), broad: wheres.some((w) => w.broad) };
			// Show where the path really goes when it is outside, or spelled in a way that hides it (URL, ~, @, .., Git Bash drive, non-ASCII).
			const odd = (t) => /^(file:|~|@)|\.\.|^\/(mnt\/|cygdrive\/)?[a-zA-Z](\/|$)|[^\x20-\x7e]/.test(t.trim());
			const resolved = wheres.map((w, i) => (!w.inside || odd(targets[i]) ? w.resolved : null));
			// Protected files and network paths always ask, with no "for this chat" and no inside-project shortcut.
			if (flags.protected || flags.unc) return askOnce(askEdit(mode, toolName, targets, resolved, flags), "edit");
			if (!flags.outside) {
				if (mode === "ask-commands" || grants.edits) return allow();
				return ask(askEdit(mode, toolName, targets, resolved, flags), { type: "edits" }, "edit");
			}
			const win = process.platform === "win32" || pathOpts.platform === "win32";
			const keys = wheres.map((w) => "path:" + (win ? w.resolved.toLowerCase() : w.resolved));
			if (keys.every((k) => grants.keys.has(k))) return allow();
			if (keys.length > 1) return askOnce(askEdit(mode, toolName, targets, resolved, flags), "edit");
			return ask(askEdit(mode, toolName, targets, resolved, flags), { type: "key", key: keys[0] }, "edit");
		}

		if (kind === "shell") {
			const command = input && typeof input === "object" ? input.command : undefined;
			if (isReadOnlyCommand(command)) return allow();
			if (mode === "plan") return block(planBlock("This command") + " Only read-only commands run in Plan mode.");
			if (typeof command !== "string" || command.trim() === "") return block("The command is empty or unreadable, so it was blocked.");
			const shown = vis(command.trim());
			if (shown.length > MAX_SHOWN) return block(tooLong("command", shown.length));
			const key = "cmd:" + command;
			if (grants.keys.has(key)) return allow();
			return ask(`Allow this command?\n${shown}\n${statusText(mode)}`, { type: "key", key }, "command");
		}

		if (kind === "subagent") {
			if (mode === "plan") return block(planBlock("A subagent") + " A subagent runs as a separate Pi that does not follow the mode.");
			const task = input && typeof input === "object" ? (input.task ?? input.prompt ?? input.description ?? "") : "";
			const key = "sub:" + stable(input);
			if (grants.keys.has(key)) return allow();
			const head = task ? `Task: ${brief(task)}\n` : "";
			return ask(`Allow a subagent?\n${head}Its own tools are not controlled by the permission mode.\n${statusText(mode)}`, { type: "key", key }, "subagent");
		}

		// unknown tools and MCP tools: treated as commands
		if (mode === "plan") return block(planBlock(`The tool "${brief(toolName, 80)}"`) + " Unknown and MCP tools count as commands.");
		const key = "tool:" + toolName + ":" + stable(input);
		if (grants.keys.has(key)) return allow();
		const detail = vis(stable(input));
		const full = detail.length <= MAX_SHOWN;
		const title = `Allow this tool call?\n${brief(toolName, 80)}  ${full ? detail : brief(stable(input), 400)}\n${statusText(mode)}`;
		return full ? ask(title, { type: "key", key }, "tool call") : askOnce(title, "tool call");
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

// Turns the user's answer to an "ask" decision into allow / block. Only the exact option text that was offered allows;
// undefined, Cancel, Esc, timeouts and anything else deny.
function applyAnswer(decision, answer, grants) {
	try {
		const offered = decision && decision.action === "ask" && decision.prompt && Array.isArray(decision.prompt.options) ? decision.prompt.options : [];
		if (offered.length && (answer === OPTIONS[0] || answer === OPTIONS[1]) && offered.includes(answer)) {
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

// An older copy of this extension in the user's Pi extensions folder (read only, to warn about the clash).
// Returns the file name found or null.
function findOldCopy(agentDir) {
	try {
		const dir = nodePath.join(agentDir, "extensions");
		for (const name of fs.readdirSync(dir)) {
			if (/^permission-modes(\.|$)/i.test(name)) return name;
			if (!/\.(ts|js|mjs)$/i.test(name)) continue;
			try {
				const text = fs.readFileSync(nodePath.join(dir, name), "utf8").slice(0, 400000);
				if (/registerCommand\(\s*["']mode["']/.test(text)) return name;
			} catch {}
		}
	} catch {}
	return null;
}

module.exports = {
	MODE_IDS, MODE_LABELS, DEFAULT_MODE, STATUS_KEY, ENTRY_TYPE, COMMAND_NAMES, OPTIONS, READ_ONLY_NAMES, MAX_SHOWN, PROTECTED_WHY,
	isMode, statusText, parseMode, restoreMode, parseLastMode,
	createGrants, clearGrants, classify, checkPath, editPathOf, editPathsOf, isReadOnlyCommand, decide, applyAnswer, vis, findOldCopy,
};
