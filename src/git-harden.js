// Hardened git: options that stop a repository from making a READ-ONLY git call run code.
// Used by the app's own automatic git calls (Changes tab, file tree, graph, checkpoints, worktree list) and by the
// permission-modes extension for the read-only git commands it lets the chat run without asking.
// Switched off on the command line (highest precedence, and passed on to child gits such as submodules):
//   core.fsmonitor (runs a program on status/diff), hooks, log.showSignature (runs gpg.program), the pager; and for
//   diff/log/show/blame --no-ext-diff (diff.external, diff.<driver>.command) and --no-textconv (diff.<driver>.textconv).
// HOOKS, exactly what is and is not off:
//   - Hooks in a hooks folder: off. core.hooksPath points at an absolute device path (NO_HOOKS) that can't exist as a
//     folder in any project, so a folder named NUL or a file written into the project can't bring a hook back.
//   - Hooks defined in git's configuration (hook.<name>.command, git 2.54 and later) are NOT switched off by
//     core.hooksPath. They are switched off by name: hook.<name>.enabled=false for every name that appears in any config
//     file git reads (extras, read from git config; see configExtras). Older git has no such hooks and ignores the option.
//     A name that git's config gets from somewhere this module can't read (a config file that appears later) is not covered.
// FILTERS: a filter driver (filter.<x>.clean / smudge / process) runs a program on status, diff and add. The drivers of
// Git LFS (their commands start with git-lfs) stay on, because LFS repositories need them. Every other driver is switched
// off (empty clean, smudge and process, required=false) for these automatic calls: a repository with a filter that runs
// project code can't make Pi Crust's own calls run that code. Cost: in a repository with such a filter the app sees files
// as they are on disk, not as the filter would store them (the Changes tab may list a file the filter normalises).
// User actions (Commit, Push, Discard, creating a worktree) do NOT use this: they keep the user's hooks and filters.
"use strict";

const { spawnSync } = require("child_process");

// \\.\NUL: a Windows device, never a folder. A relative "NUL" would be resolved against the project, where a free edit can
// create a real folder with that name (Node may; git then finds hooks in it). Forward slashes: safe in bash and PowerShell.
const NO_HOOKS = process.platform === "win32" ? "//./NUL" : "/dev/null";
const GLOBAL = ["-c", "core.fsmonitor=false", "-c", `core.hooksPath=${NO_HOOKS}`, "-c", "log.showSignature=false", "--no-pager"];
const DIFF_SUBS = new Set(["diff", "log", "show", "blame"]);
const DIFF_FLAGS = ["--no-ext-diff", "--no-textconv"];

// A name usable inside a shell command line without quoting in bash and PowerShell.
const SAFE_NAME = /^[A-Za-z0-9_.-]+$/;
// The commands of Git LFS's drivers ("git-lfs filter-process", "git lfs clean -- %f").
const LFS_COMMAND = /^\s*"?git[- ]lfs(\.exe)?"?(\s|$)/i;

// "origin\0key\nvalue\0" (with --show-origin) or "key\nvalue\0"; a key without a value has no newline.
function parseList(out, withOrigin) {
	const parts = String(out || "").split("\0");
	const rows = [];
	for (let i = 0; i < parts.length; i++) {
		let origin = null;
		if (withOrigin) {
			origin = parts[i];
			i++;
		}
		const rec = parts[i];
		if (rec === undefined || rec === "") continue;
		const nl = rec.indexOf("\n");
		rows.push({ origin, key: nl < 0 ? rec : rec.slice(0, nl), value: nl < 0 ? "" : rec.slice(nl + 1) });
	}
	return rows;
}

// rows ([{ key, value }]) -> { hookNames: [...], filters: [names of drivers that are not Git LFS] }
function configExtras(rows) {
	const hooks = new Set();
	const filters = new Map(); // name -> runs something that is not LFS
	for (const r of rows || []) {
		const m = String(r.key).match(/^(hook|filter)\.(.+)\.([^.]+)$/i);
		if (!m) continue;
		const [, section, name, variable] = m;
		if (section.toLowerCase() === "hook") hooks.add(name);
		else if (/^(clean|smudge|process)$/i.test(variable)) {
			const v = String(r.value || "").trim();
			if (v && !LFS_COMMAND.test(v)) filters.set(name, true);
			else if (!filters.has(name)) filters.set(name, false);
		}
	}
	return { hookNames: [...hooks], filters: [...filters].filter(([, on]) => on).map(([n]) => n) };
}
// The switches for a set of extras, as argv words.
function extraArgs(extras) {
	const out = [];
	if (!extras) return out;
	for (const n of extras.hookNames || []) out.push("-c", `hook.${n}.enabled=false`);
	for (const n of extras.filters || []) out.push("-c", `filter.${n}.clean=`, "-c", `filter.${n}.smudge=`, "-c", `filter.${n}.process=`, "-c", `filter.${n}.required=false`);
	return out;
}

// Reads the extras of the repository at cwd (one `git config --list`), remembered for a few seconds.
// Unreadable (no git, no repository, timeout): no extras.
const memo = new Map();
function readExtras(cwd, opts = {}) {
	if (typeof cwd !== "string" || !cwd) return { hookNames: [], filters: [] };
	const now = Date.now();
	const hit = memo.get(cwd);
	if (hit && now - hit.at < (opts.ttl ?? 3000)) return hit.v;
	let v = { hookNames: [], filters: [] };
	try {
		const spawn = opts.spawn || spawnSync;
		const r = spawn("git", [...GLOBAL, "config", "--list", "-z"], { cwd, encoding: "utf8", timeout: 5000, windowsHide: true, maxBuffer: 20e6, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" } });
		if (!r.error && r.status === 0) v = configExtras(parseList(r.stdout, false));
	} catch {
		// no extras
	}
	if (memo.size > 200) memo.clear();
	memo.set(cwd, { at: now, v });
	return v;
}
const clearExtrasCache = () => memo.clear();

// ["status", ...] -> ["-c", ..., "--no-pager", "status", ...]; diff-like subcommands also get --no-ext-diff --no-textconv.
// opts.extras (from configExtras) or opts.cwd (the repository: its config is read) adds the hook and filter switches.
function hardenGitArgs(args, opts = {}) {
	const a = Array.isArray(args) ? args.map(String) : [];
	const extras = opts.extras || (opts.cwd ? readExtras(opts.cwd) : null);
	const head = [...GLOBAL, ...extraArgs(extras)];
	if (!a.length) return head;
	const [sub, ...rest] = a;
	return [...head, sub, ...(DIFF_SUBS.has(sub) ? DIFF_FLAGS : []), ...rest];
}

// The same for a shell command line "git <sub> <rest>" (bash or PowerShell). The words added contain no character
// either shell treats specially. The first two words must be plain (no quotes); otherwise null (the caller asks instead).
// A hook or filter name that can't be written safely on a command line also gives null.
function hardenGitCommand(line, opts = {}) {
	if (typeof line !== "string") return null;
	const m = line.match(/^([ \t]*)(git)([ \t]+)([A-Za-z-]+)(?=[ \t]|$)([\s\S]*)$/i);
	if (!m) return null;
	const [, lead, git, , sub, rest] = m;
	const subL = sub.toLowerCase();
	const extras = opts.extras || null;
	if (extras && [...(extras.hookNames || []), ...(extras.filters || [])].some((n) => !SAFE_NAME.test(n))) return null;
	const words = [...GLOBAL, ...extraArgs(extras)];
	return `${lead}${git} ${words.join(" ")} ${sub}${DIFF_SUBS.has(subL) ? " " + DIFF_FLAGS.join(" ") : ""}${rest}`;
}

module.exports = { NO_HOOKS, hardenGitArgs, hardenGitCommand, GIT_HARDEN_GLOBAL: GLOBAL, parseList, configExtras, extraArgs, readExtras, clearExtrasCache, LFS_COMMAND };
