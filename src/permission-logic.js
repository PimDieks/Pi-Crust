// Permission-mode decisions (used by pi-extension/permission-modes.ts). Pure: no Pi, no Electron, no UI.
// decide({ mode, toolName, input, cwd, grants }) -> { action: "allow" | "ask" | "block", reason?, prompt?, grant? }
// Fail closed: anything unknown, unparsable or thrown is a block (or an ask), never an allow.
// Modes are a safety net in front of tools, not a sandbox.
"use strict";

const fs = require("fs");
const os = require("os");
const nodePath = require("path");
const { hardenGitCommand } = require("./git-harden");

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
// Trusted is never carried over: not to a new chat (the "last chosen" file) and not to a chat that comes back from a saved session (a tab
// restored after an app restart). A person switches a chat to Trusted for that chat only; everything else starts in Ask before commands.
const carried = (m) => (isMode(m) && m !== "trusted" ? m : DEFAULT_MODE);
// What goes into the "last chosen" file for a mode the person just chose: Trusted is stored as Ask before commands.
const lastModeToStore = (mode) => carried(mode);
// The mode saved in a session: last custom entry of ours. No entry -> null (caller uses the last chosen / default).
// An entry that cannot be read, or that says Trusted -> Ask before commands, never Trusted.
function restoreMode(entries) {
	try {
		if (!Array.isArray(entries)) return DEFAULT_MODE;
		for (let i = entries.length - 1; i >= 0; i--) {
			const e = entries[i];
			if (e && e.type === "custom" && e.customType === ENTRY_TYPE) return e.data ? carried(e.data.mode) : DEFAULT_MODE;
		}
		return null;
	} catch {
		return DEFAULT_MODE;
	}
}
// The "last chosen" file content: {"mode": "<id>"}. Anything else, and Trusted (an older file may still say it) -> Ask before commands.
function parseLastMode(text) {
	try {
		return carried(JSON.parse(String(text)).mode);
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

// ONE canonical form for every name the protected list compares, so a name can't be checked one way and written another.
// It folds every spelling Windows may treat as the same file: an NTFS stream ("HEAD::$DATA", "x:stream" -> the part
// before the first ":"), trailing dots and spaces ("HEAD. "), and ASCII case. Only ASCII is folded: NTFS does not fold
// the Kelvin sign or a dotless i (tested), and JS toLowerCase would. 8.3 short names (GIT~1) of existing files are
// resolved by the real path; a new file has no short name. Over-folding only ever protects more.
const asciiLower = (s) => String(s).replace(/[A-Z]/g, (c) => c.toLowerCase());
function canonName(comp) {
	return asciiLower(String(comp).split(":")[0].replace(/[. ]+$/, ""));
}
// A path as [root, ...canonical components] (separators and the drive letter's case don't matter).
function canonParts(p, P) {
	const root = P.parse(p).root;
	return [asciiLower(root.replace(/[\\/]+/g, "/")), ...p.slice(root.length).split(/[\\/]+/).filter(Boolean).map(canonName)];
}
const underParts = (child, parent) => child.length >= parent.length && parent.every((c, i) => child[i] === c);

// Names whose contents decide what git or Pi will RUN (hooks, fsmonitor, diff drivers, session dir, extensions ...),
// anywhere in the path. More come from git's own configuration (permission-git.js), passed in as opts.protect.
const PROTECTED_NAMES = new Set([".git", ".pi", ".gitattributes", ".gitmodules", ".husky", ".githooks"]);
function protectedName(comp) {
	const c = canonName(comp);
	return PROTECTED_NAMES.has(c) || /^git\w*~\d+$/.test(c);
}
// DOS device names (NUL, CON, PRN, AUX, COM1-9, LPT1-9, CONIN$, CONOUT$): Windows resolves them to a device whatever the
// extension ("nul.txt", "NUL.tar.gz"), trailing dots and spaces ("NUL. ") or stream ("NUL:x"). Node can still create a real
// folder with that name below the project through a \\?\ path, where git then finds hooks that it cannot start: that breaks
// git's safety settings and the app's checkpoints. No project needs one, so a write to one always asks (blocked in Plan).
function deviceName(comp) {
	const stem = canonName(comp).split(".")[0].replace(/ +$/, "");
	return /^(nul|con|prn|aux|conin\$|conout\$|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])$/.test(stem);
}
const PROTECTED_WHY = "This file can change what git or Pi runs.";
const DEVICE_WHY = "This name is a Windows device name (NUL, CON, COM1 ...). A file or folder called that can break git's safety settings.";
const HIDDEN_WHY = "This text has hidden characters or a long run of spaces. Check every character before you allow it.";
// The characters vis() turns into markers (a newline is not one: a command may have lines), and a run of 3+ spaces or tabs.
const HIDDEN_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cs}\p{Cn}\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000\u115F\u1160\u3164\uFFA0\u2800\u180E\uFE00-\uFE0F]/u;
function hasHidden(s) {
	const t = String(s ?? "").replace(/\r?\n/g, " ");
	return /[ \t]{3,}/.test(t) || HIDDEN_CHARS.test(t);
}
const PROGRAM_WHY = "This file can change which program a command runs.";
const UNKNOWN_GIT_WHY = "Pi Crust could not read git's settings for this project, so every edit asks.";

// Programs a command line or the app starts by name. A file with one of these names (plus an executable extension)
// in a folder the shell searches would run instead of the real program. Windows also searches the current folder
// (where.exe, CreateProcess), so the project folder itself counts there.
const SHADOW_EXTRA = ["git", "bash", "sh", "powershell", "pwsh", "cmd", "node", "npm", "npx", "where", "conhost"];
const EXEC_EXT = /\.(exe|com|bat|cmd|ps1|vbs|vbe|js|jse|wsf|wsh|msc)$/;
function shadowName(comp) {
	const base = canonName(comp).replace(EXEC_EXT, "");
	return SHADOW_EXTRA.includes(base) || Object.prototype.hasOwnProperty.call(READ_ONLY_COMMANDS, base);
}
// Folders a shell searches for programs: PATH, PowerShell's module path, and the home bin folders that Git Bash and
// most login shells put on PATH.
function searchDirs(env, home, P, win) {
	const out = [];
	for (const k of Object.keys(env || {})) if (/^(path|psmodulepath)$/i.test(k)) for (const d of String(env[k] || "").split(win ? ";" : ":")) out.push(d.trim().replace(/^"(.*)"$/, "$1"));
	out.push(P.join(home, "bin"), P.join(home, ".local", "bin"));
	return out;
}

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
	if (typeof rawPath !== "string") return { inside: false, resolved: String(rawPath), unc: false, protected: false, why: [] };
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
			out.why = [...new Set([...(out.why || []), ...(r.why || [])])];
		}
	}
	return out;
}
// Real paths of the protected / search folders change rarely: remembered for a few seconds.
const realMemo = new Map();
function memoReal(p, real) {
	const hit = realMemo.get(p);
	const now = Date.now();
	if (hit && now - hit.at < 5000) return hit.v;
	let v = null;
	try {
		v = real(p);
	} catch {}
	if (realMemo.size > 2000) realMemo.clear();
	realMemo.set(p, { at: now, v });
	return v;
}
function checkOne(rawPath, cwd, opts) {
	const platform = opts.platform || process.platform;
	const win = platform === "win32";
	const P = win ? nodePath.win32 : nodePath.posix;
	const realpath = opts.realpath || ((p) => fs.realpathSync.native(p));
	const home = opts.home || os.homedir();
	const agentDir = opts.agentDir || process.env.PI_CODING_AGENT_DIR || P.join(home, ".pi", "agent");
	const res = (o) => ({ inside: false, resolved: String(rawPath), unc: false, protected: false, broad: false, why: [], ...o });
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
			// any other scheme (http:, ftp:, FILE: ...) is not a plain path: outside. On NTFS "HEAD:x" is a stream of HEAD,
			// so the part before the colon is still judged by the protected list (H1).
			const first = canonName(raw.split(/[\\/]/)[0]);
			const why = [];
			if (protectedName(first) || first === "head") why.push("git");
			if (shadowName(first)) why.push("program");
			if (deviceName(first)) why.push("device");
			return res({ why, protected: why.length > 0 });
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
		const key = (p) => (win ? asciiLower(p) : p); // NTFS folds ASCII case only (N3)
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
		// Protected list: judged on the lexical AND the real path, every comparison on canonical parts (canonParts).
		const why = new Set();
		const rp = opts.realpath
			? (p) => {
					try {
						return real(p);
					} catch {
						return null;
					}
				}
			: (p) => memoReal(p, real);
		const forms = (p) => {
			const r = rp(p);
			return r && r !== p ? [canonParts(p, P), canonParts(r, P)] : [canonParts(p, P)];
		};
		const targets = [canonParts(abs, P), canonParts(realAbs, P)];
		const bases = [canonParts(base, P), canonParts(realBase, P)];
		const hits = (dirForms) => targets.some((t) => dirForms.some((d) => underParts(t, d)));
		for (const t of targets) {
			const b = bases.find((x) => underParts(t, x) && t.length > x.length);
			const comps = b ? t.slice(b.length) : t.slice(1);
			if (comps.some(protectedName)) why.add("git");
			if (comps.some(deviceName)) why.add("device");
			if (b && comps.length === 1 && comps[0] === "head") why.add("git"); // root-level HEAD (a bare repository)
			if (b && comps.length === 1 && win && shadowName(comps[0])) why.add("program"); // Windows searches the current folder
		}
		// What git's configuration says it runs or loads for this project (permission-git.js).
		const prot = opts.protect && typeof opts.protect === "object" ? [...(opts.protect.files || []), ...(opts.protect.dirs || [])] : [];
		for (const f of prot) if (typeof f === "string" && f && hits(forms(P.resolve(base, f)))) why.add("git");
		// Folders the shell searches for programs. Outside the project: everything in them (programs there load their own
		// files from below). Inside the project (a relative PATH entry such as "." or node_modules/.bin): a file named like
		// a command, directly in that folder. A search folder that contains the project: only its direct children count.
		for (const d of searchDirs(opts.env || process.env, home, P, win)) {
			let dir;
			try {
				dir = P.resolve(base, d || ".");
			} catch {
				continue;
			}
			const df = forms(dir);
			if (!hits(df)) continue;
			const child = targets.some((t) => df.some((x) => t.length === x.length + 1 && underParts(t, x)));
			const projectDir = df.some((x) => bases.some((b) => underParts(x, b)));
			const holdsProject = df.some((x) => bases.some((b) => underParts(b, x)));
			if (projectDir) {
				if (child && targets.some((t) => shadowName(t[t.length - 1]))) why.add("program");
			} else if (holdsProject) {
				if (child) why.add("program");
			} else why.add("program");
		}
		if (!inside) {
			if (targets.some((t) => t.slice(1).some(protectedName))) why.add("git");
			if (hits(forms(agentDir))) why.add("pi"); // Pi's own config, sessions and extensions
			const hp = canonParts(home, P);
			if (targets.some((t) => t.length === hp.length + 1 && underParts(t, hp) && t[t.length - 1].startsWith("."))) why.add("home"); // ~/.gitconfig, ~/.bashrc ...
		}
		return { inside, resolved: realAbs, unc: false, protected: why.size > 0, broad, why: [...why] };
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
// Inside quotes, for the search commands under bash only (find . -name "*.ts", rg "a.*b" src): bash neither globs nor
// expands there. $ and ` still expand inside double quotes, so they stay out; so does every control character.
// PowerShell is not relaxed: the msys runtime globs a quoted '*' again for Git's programs (review 2, demo/psglob).
const FORBIDDEN_QUOTED_BASH = /[$`!\x00-\x08\x0a-\x1f\x7f]/;
const SEARCH_COMMANDS = new Set(["find", "rg", "grep"]);

// Split on spaces/tabs outside quotes, remembering for every character whether it was quoted. Returns null when the
// line's quoting is not plain, because then this split and the shell's split can differ (H7):
//   unbalanced quotes; a backslash before a quote (\" is a literal quote to bash outside quotes, and an escaped quote
//   inside double quotes, so an option could hide in what looks like a quoted string: H7); outside bash, a quote
//   character inside the other kind of quotes (Windows PowerShell 5.1 passes it on unescaped, so the program's own
//   argument parser may split one argument into several).
function tokenize(line, shell) {
	if (/\\["']/.test(line)) return null;
	const tokens = [];
	let cur = null;
	let quote = null;
	for (const ch of line) {
		if (quote) {
			if (ch === quote) quote = null;
			else if ((ch === "'" || ch === '"') && shell !== "bash") return null;
			cur.raw += ch;
			if (ch !== quote) cur.quoted.push(ch);
		} else if (ch === "'" || ch === '"') {
			quote = ch;
			cur = cur || { raw: "", quoted: [], plain: [] };
			cur.raw += ch;
		} else if (ch === " " || ch === "\t") {
			if (cur) tokens.push(cur);
			cur = null;
		} else {
			cur = cur || { raw: "", quoted: [], plain: [] };
			cur.raw += ch;
			cur.plain.push(ch);
		}
	}
	if (quote) return null;
	if (cur) tokens.push(cur);
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
		// `git --version` and `git version`, alone: they print the version and read nothing. Nothing after them (no --build-options).
		if (args.length === 1 && (args[0] === "--version" || args[0] === "version")) return true;
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

// shell: "bash" | "powershell" | anything else (unknown: strictest rules). Only the shell the tool call really runs in
// may relax anything, so the caller passes what it knows and an unknown shell gets no relaxation.
function isReadOnlyCommand(command, shell) {
	try {
		if (typeof command !== "string") return false;
		const line = command.trim();
		if (!line || line.length > MAX_SHOWN || vis(line).length > MAX_SHOWN) return false; // longer: never without a question
		// Outside bash (PowerShell, cmd, an unknown shell, WSL) the shell's own rules for splitting arguments are not the
		// ones tokenize() knows: PowerShell splits on U+00A0, U+2000-U+200A, U+0085, U+2028 and reads curly quotes as quotes
		// (R1: `git log x<NBSP>--output=README.md` truncated a file). So a command there is read-only only when it is
		// printable ASCII, spaces and tabs (blanks and line ends around it are trimmed); anything else asks, or is blocked in Plan.
		if (shell !== "bash" && /[^\x20-\x7e\t]/.test(command.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, ""))) return false;
		const tokens = tokenize(line, shell);
		if (!tokens || !tokens.length) return false;
		const name = tokens[0].raw.toLowerCase();
		if (!Object.prototype.hasOwnProperty.call(READ_ONLY_COMMANDS, name)) return false; // raw token: no quotes, escapes or VAR=x prefix
		const relaxed = shell === "bash" && SEARCH_COMMANDS.has(name);
		for (const t of tokens) {
			if (FORBIDDEN_CHARS.test(t.plain.join(""))) return false;
			if ((relaxed ? FORBIDDEN_QUOTED_BASH : FORBIDDEN_CHARS).test(t.quoted.join(""))) return false;
		}
		const rest = tokens.slice(1).map((t) => t.raw);
		if (rest.some(badArg)) return false;
		if (shell !== "bash" && rest.some((a) => effective(a) === "--%")) return false; // PowerShell: stop-parsing, the rest goes raw
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
// Longest command, path or tool input that may be auto-allowed or get "Allow for this chat". Longer text is never
// cut: the prompt carries all of it (the dialog scrolls), with "Allow once" / "Deny" only and a line saying how long it
// is. Text beyond MAX_ASKABLE is refused: nobody reads that much before approving.
const MAX_SHOWN = 600;
const MAX_ASKABLE = 20000;
const longLine = (what, n) => `This ${what} is ${n} characters long. Read all of it before you allow it.`;

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
const tooLong = (what, n) => `This ${what} is ${n} characters long, too long for anyone to read before approving it, so it was blocked. Split it up: write long text with the write tool, or a commit message to a file and use git commit -F.`;

function planBlock(what) {
	return `Plan mode is read-only. ${what} is not allowed. Describe the change as a plan and ask the user to switch to another mode if it should be carried out.`;
}
const DENIED = (what) => `The user denied this ${what}. Don't try it again or another way around it. Ask the user what to do.`;

function askEdit(mode, toolName, shown, resolved, flags) {
	const head = flags.outside ? "Allow this edit OUTSIDE the project folder?" : "Allow this edit?";
	const lines = [head];
	const why = new Set(flags.why || []);
	if (why.has("git") || why.has("pi") || why.has("home")) lines.push(PROTECTED_WHY);
	if (why.has("program")) lines.push(PROGRAM_WHY);
	if (why.has("device")) lines.push(DEVICE_WHY);
	if (why.has("hidden")) lines.push(HIDDEN_WHY);
	if (why.has("unknown")) lines.push(UNKNOWN_GIT_WHY);
	if (flags.long) lines.push(longLine("path", flags.long));
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
// prompt.risky: the prompt offers only "Allow once" and "Deny" and opens on "Deny" (protected files, network paths, text that is
// not fully shown, hidden characters). The UIs (renderer.js, remote/app.js) read it from the prompt itself: no "Allow for this
// chat" among the options, or one of the warning lines (PERM_REASON). Both are always set together here.
const ask = (title, grant, deniedWhat, options) => {
	const o = (options || OPTIONS).slice();
	return { action: "ask", prompt: { title, options: o, risky: !o.includes(OPTIONS[1]) }, grant, deniedReason: DENIED(deniedWhat) };
};
const askOnce = (title, deniedWhat) => ask(title, undefined, deniedWhat, OPTIONS_ONCE);

function decide(args) {
	try {
		const { mode, toolName, input, cwd } = args || {};
		const grants = (args && args.grants) || createGrants();
		if (!isMode(mode)) return block("Permission mode is unreadable, so the call was blocked. Ask the user to pick a mode again.");
		if (typeof toolName !== "string" || toolName === "") return block("The tool call has no readable tool name, so it was blocked.");
		const kind = classify(toolName);
		const pathOpts = { ...(args.pathOptions || {}) };
		if (args.protect !== undefined) pathOpts.protect = args.protect;
		// git's settings could not be read: nothing it might run can be ruled out (fail closed, H2).
		const gitUnknown = !!(pathOpts.protect && pathOpts.protect.ok === false);
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
			const longest = Math.max(...targets.map((t) => vis(t).length));
			if (longest > MAX_ASKABLE) return block(tooLong("file path", longest));
			const wheres = targets.map((t) => checkPath(t, cwd, pathOpts));
			const why = [...new Set(wheres.flatMap((w) => w.why || []))];
			if (gitUnknown) why.push("unknown");
			if (targets.some(hasHidden)) why.push("hidden");
			const flags = { outside: wheres.some((w) => !w.inside), protected: why.length > 0, unc: wheres.some((w) => w.unc), broad: wheres.some((w) => w.broad), why, long: longest > MAX_SHOWN ? longest : 0 };
			// Show where the path really goes when it is outside, or spelled in a way that hides it (URL, ~, @, .., Git Bash drive, non-ASCII).
			const odd = (t) => /^(file:|~|@)|\.\.|^\/(mnt\/|cygdrive\/)?[a-zA-Z](\/|$)|[^\x20-\x7e]/.test(t.trim());
			const resolved = wheres.map((w, i) => (!w.inside || odd(targets[i]) ? w.resolved : null));
			// Protected files, network paths and paths too long to take in at a glance always ask, with no "for this chat"
			// and no inside-project shortcut.
			if (flags.protected || flags.unc || flags.long) return askOnce(askEdit(mode, toolName, targets, resolved, flags), "edit");
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
			const shell = args.shell === "bash" && toolName === "bash" ? "bash" : toolName === "powershell" ? "powershell" : "unknown";
			if (isReadOnlyCommand(command, shell)) {
				const name = command.trim().split(/[ \t]/)[0].toLowerCase();
				if (name !== "git") return allow();
				// git reads settings and hooks from the project. Allowed without a question only in its hardened form
				// (git-harden.js), and only while git's settings for this project are known.
				const hardened = gitUnknown ? null : hardenGitCommand(command, { extras: pathOpts.protect && pathOpts.protect.extras });
				if (hardened) return { action: "allow", rewrite: hardened };
			}
			if (mode === "plan") return block(planBlock("This command") + " Only read-only commands run in Plan mode.");
			if (typeof command !== "string" || command.trim() === "") return block("The command is empty or unreadable, so it was blocked.");
			const shown = vis(command.trim());
			if (shown.length > MAX_ASKABLE) return block(tooLong("command", shown.length));
			const hidden = hasHidden(command.trim()) ? HIDDEN_WHY + "\n" : "";
			if (shown.length > MAX_SHOWN) return askOnce(`Allow this command?\n${hidden}${longLine("command", shown.length)}\n${shown}\n${statusText(mode)}`, "command");
			if (hidden) return askOnce(`Allow this command?\n${hidden}${shown}\n${statusText(mode)}`, "command");
			const key = "cmd:" + command;
			if (grants.keys.has(key)) return allow();
			return ask(`Allow this command?\n${shown}\n${statusText(mode)}`, { type: "key", key }, "command");
		}

		if (kind === "subagent") {
			if (mode === "plan") return block(planBlock("A subagent") + " A subagent runs as a separate Pi that does not follow the mode.");
			const task = input && typeof input === "object" ? (input.task ?? input.prompt ?? input.description ?? "") : "";
			const key = "sub:" + stable(input);
			if (hasHidden(stable(input))) return askOnce(`Allow a subagent?\n${HIDDEN_WHY}\n${task ? `Task: ${brief(task)}\n` : ""}Its own tools are not controlled by the permission mode.\n${statusText(mode)}`, "subagent");
			if (grants.keys.has(key)) return allow();
			const head = task ? `Task: ${brief(task)}\n` : "";
			return ask(`Allow a subagent?\n${head}Its own tools are not controlled by the permission mode.\n${statusText(mode)}`, { type: "key", key }, "subagent");
		}

		// unknown tools and MCP tools: treated as commands
		if (mode === "plan") return block(planBlock(`The tool "${brief(toolName, 80)}"`) + " Unknown and MCP tools count as commands.");
		const detail = vis(stable(input));
		if (detail.length > MAX_ASKABLE) return block(tooLong("tool call", detail.length));
		const hiddenTool = hasHidden(stable(input)) || hasHidden(toolName) ? HIDDEN_WHY + "\n" : "";
		if (detail.length > MAX_SHOWN) return askOnce(`Allow this tool call?\n${hiddenTool}${longLine("tool call", detail.length)}\n${brief(toolName, 80)}  ${detail}\n${statusText(mode)}`, "tool call");
		if (hiddenTool) return askOnce(`Allow this tool call?\n${hiddenTool}${brief(toolName, 80)}  ${detail}\n${statusText(mode)}`, "tool call");
		const key = "tool:" + toolName + ":" + stable(input);
		if (grants.keys.has(key)) return allow();
		return ask(`Allow this tool call?\n${brief(toolName, 80)}  ${detail}\n${statusText(mode)}`, { type: "key", key }, "tool call");
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

// The input fields a decision read, which must not change before the tool runs (H4). Other fields stay writable, so a
// later extension may still add a timeout; "all" freezes the whole input (unknown tools and subagents were shown whole).
const READ_PATH_KEYS = [...PATH_KEYS, "cwd", "dir", "directory"];
function pinKeys(toolName) {
	const kind = classify(toolName);
	if (kind === "shell") return ["command"];
	if (kind === "edit") return PATH_KEYS.slice();
	if (READ_TOOLS.has(String(toolName))) return READ_PATH_KEYS.slice();
	if (kind === "safe") return [];
	return "all";
}

// Which shell a bash tool call really runs in, from the shellPath settings Pi would use (none, one or two; "" / null / undefined
// count as unset) and the machine. "bash" only for a Git Bash or a real bash; "unknown" (strict rules, like PowerShell) for
// anything else, and for WSL's bash.exe (System32 / Sysnative / the WindowsApps launcher): it is a Linux shell with its own
// quoting, and the git it runs is not Windows git. On Windows with no shellPath, Pi uses Git Bash from Program Files, else any
// bash.exe on PATH (could be WSL): only the first is known.
function bashShellKind({ platform = process.platform, shellPaths = [], env = process.env, exists = (p) => fs.existsSync(p) } = {}) {
	try {
		const win = platform === "win32";
		const set = shellPaths.filter((p) => p !== undefined && p !== null && p !== "");
		for (const sp of set) {
			if (typeof sp !== "string") return "unknown";
			const s = sp.trim();
			if (!/^bash(\.exe)?$/i.test((win ? nodePath.win32 : nodePath.posix).basename(s))) return "unknown";
			if (win && /[\\/](system32|sysnative|windowsapps)[\\/]/i.test(s)) return "unknown";
		}
		if (set.length) return "bash";
		if (!win) return "bash";
		for (const pf of [env.ProgramFiles, env["ProgramFiles(x86)"]]) if (pf && exists(nodePath.win32.join(pf, "Git", "bin", "bash.exe"))) return "bash";
		return "unknown";
	} catch {
		return "unknown";
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

// The old copy for the selector: { name, dir (home shown as ~, for the text), file (full path, for "Show the file") } or null.
function describeOldCopy(agentDir, home) {
	const name = findOldCopy(agentDir);
	if (!name) return null;
	const dir = nodePath.join(agentDir, "extensions");
	const h = home ? nodePath.resolve(home) : "";
	const shown = h && (dir === h || dir.startsWith(h + nodePath.sep)) ? "~" + dir.slice(h.length) : dir;
	return { name, dir: shown, file: nodePath.join(dir, name) };
}

module.exports = {
	MODE_IDS, MODE_LABELS, DEFAULT_MODE, STATUS_KEY, ENTRY_TYPE, COMMAND_NAMES, OPTIONS, READ_ONLY_NAMES, MAX_SHOWN, MAX_ASKABLE, PROTECTED_WHY, PROGRAM_WHY,
	isMode, statusText, parseMode, restoreMode, parseLastMode, lastModeToStore, canonName,
	createGrants, clearGrants, classify, checkPath, bashShellKind, hasHidden, deviceName, DEVICE_WHY, HIDDEN_WHY, editPathOf, editPathsOf, isReadOnlyCommand, decide, applyAnswer, vis, findOldCopy, describeOldCopy, pinKeys,
};
