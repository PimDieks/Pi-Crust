// Hardened git: options that stop a repository from making a READ-ONLY git call run code.
// Used by the app's own automatic git calls (Changes tab, file tree, graph, checkpoints, worktree list) and by the
// permission-modes extension for the read-only git commands it lets the chat run without asking.
// Switched off on the command line (highest precedence, and passed on to child gits such as submodules):
//   core.fsmonitor (runs a program on status/diff), hooks (core.hooksPath -> the NUL device: post-index-change,
//   reference-transaction ...), log.showSignature (runs gpg.program), the pager; and for diff/log/show/blame
//   --no-ext-diff (diff.external, diff.<driver>.command) and --no-textconv (diff.<driver>.textconv).
// Filter drivers (filter.<x>.clean) stay on: a driver is defined only in git config, every file of which is protected
// by the permission modes (see permission-git.js), and LFS repositories need them.
// User actions (Commit, Push, Discard, creating a worktree) do NOT use this: they keep the user's hooks.
"use strict";

const NO_HOOKS = process.platform === "win32" ? "NUL" : "/dev/null"; // a device: nothing can be created below it
const GLOBAL = ["-c", "core.fsmonitor=false", "-c", `core.hooksPath=${NO_HOOKS}`, "-c", "log.showSignature=false", "--no-pager"];
const DIFF_SUBS = new Set(["diff", "log", "show", "blame"]);
const DIFF_FLAGS = ["--no-ext-diff", "--no-textconv"];

// ["status", ...] -> ["-c", ..., "--no-pager", "status", ...]; diff-like subcommands also get --no-ext-diff --no-textconv.
function hardenGitArgs(args) {
	const a = Array.isArray(args) ? args.map(String) : [];
	if (!a.length) return [...GLOBAL];
	const [sub, ...rest] = a;
	return [...GLOBAL, sub, ...(DIFF_SUBS.has(sub) ? DIFF_FLAGS : []), ...rest];
}

// The same for a shell command line "git <sub> <rest>" (bash or PowerShell). The words added contain no character
// either shell treats specially. The first two words must be plain (no quotes); otherwise null (the caller asks instead).
function hardenGitCommand(line) {
	if (typeof line !== "string") return null;
	const m = line.match(/^([ \t]*)(git)([ \t]+)([A-Za-z-]+)(?=[ \t]|$)([\s\S]*)$/i);
	if (!m) return null;
	const [, lead, git, , sub, rest] = m;
	const subL = sub.toLowerCase();
	return `${lead}${git} ${GLOBAL.join(" ")} ${sub}${DIFF_SUBS.has(subL) ? " " + DIFF_FLAGS.join(" ") : ""}${rest}`;
}

module.exports = { NO_HOOKS, hardenGitArgs, hardenGitCommand, GIT_HARDEN_GLOBAL: GLOBAL };
