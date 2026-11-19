// Loaded only by Pi Crust (`pi --mode rpc -e <this file>`; terminal users can load it with `pi -e` too).
// Enforces the four permission modes (Plan, Ask before edits, Ask before commands, Trusted) in front of every tool call,
// and answers `/mode <id>` with the status "Mode: <label>" that the app's selector follows.
// The decisions live in ../permission-logic.js (unit tested). This file only wires them to Pi and fails closed:
// no UI to ask, an error, Cancel, Esc, a timeout or an unreadable mode all mean the call is blocked.
// Modes are a safety net in front of tools, not a sandbox.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
// @ts-ignore plain CommonJS module
import * as logic from "../permission-logic.js";
// @ts-ignore plain CommonJS module
import * as permGit from "../permission-git.js";
// @ts-ignore plain CommonJS module
import * as secretEnv from "../secret-env.js";

type Block = { block: true; reason: string };

// "Last chosen" mode, so a new chat starts where the user left off. A new install has no file: Ask before commands. Trusted is not carried over.
function lastModeFile(): string {
	return path.join(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"), "crust-permission-mode.json");
}
function readLastMode(): string {
	try {
		return logic.parseLastMode(fs.readFileSync(lastModeFile(), "utf8"));
	} catch {
		return logic.DEFAULT_MODE; // no file yet (new install) or unreadable
	}
}
function writeLastMode(mode: string) {
	try {
		const f = lastModeFile();
		fs.mkdirSync(path.dirname(f), { recursive: true });
		fs.writeFileSync(f, JSON.stringify({ mode: logic.lastModeToStore(mode) })); // Trusted is stored as Ask before commands
	} catch {
		// not saving is harmless: the next new chat starts in the default
	}
}

function deepFreeze(v: any, seen = new Set<any>()) {
	if (v === null || typeof v !== "object" || seen.has(v)) return;
	seen.add(v);
	Object.freeze(v);
	for (const k of Object.keys(v)) deepFreeze(v[k], seen);
}
// Makes the fields a decision read read-only, and keeps them that way (H4). A field that was absent stays absent to
// Object.keys and JSON, but can't be added later. Every other field stays writable for well-behaved later extensions.
function pin(input: any, keys: string[] | "all") {
	if (keys === "all") return deepFreeze(input);
	for (const k of keys) {
		const has = Object.prototype.hasOwnProperty.call(input, k);
		const value = input[k];
		deepFreeze(value);
		const desc: any = has ? Object.getOwnPropertyDescriptor(input, k) : null;
		Object.defineProperty(input, k, { value, writable: false, configurable: false, enumerable: desc ? !!desc.enumerable : false });
	}
}

// Which shell the bash tool really runs. Pi uses settings.shellPath when it is set (global or project settings),
// otherwise Git Bash on Windows (or whatever bash.exe is on PATH: that may be WSL) or bash elsewhere. Only a Git Bash or a real
// bash counts as "bash"; a WSL bash.exe, any other shell, or settings that can't be read: "unknown" (strictest rules).
function bashToolShell(cwd: string): string {
	const shellPaths = readShellPaths(cwd);
	return shellPaths === null ? "unknown" : logic.bashShellKind({ shellPaths });
}
// The shellPath values of Pi's global and project settings (unset ones are undefined), or null when a settings file can't be read.
function readShellPaths(cwd: string): unknown[] | null {
	const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
	const shellPaths: unknown[] = [];
	for (const f of [path.join(agentDir, "settings.json"), path.join(cwd || ".", ".pi", "settings.json")]) {
		let text: string;
		try {
			text = fs.readFileSync(f, "utf8");
		} catch (e: any) {
			if (e && e.code === "ENOENT") continue;
			return null;
		}
		try {
			shellPaths.push(JSON.parse(text).shellPath);
		} catch {
			return null;
		}
	}
	return shellPaths;
}
// Names (never values) of the variables a command may keep: the app's commandEnvKeep setting, handed over in this variable.
function keepList(): string[] {
	try {
		return secretEnv.parseKeepList(JSON.parse(process.env.PI_CRUST_ENV_KEEP || "[]"));
	} catch {
		return [];
	}
}

export default function (pi: ExtensionAPI) {
	if (typeof (pi as any).on !== "function" || typeof (pi as any).registerCommand !== "function") return; // old Pi: stay inactive, the app shows why

	let mode: string = logic.DEFAULT_MODE; // strict until session_start says otherwise
	const grants = logic.createGrants();

	// What git runs or loads for this project (permission-git.js), and which shell the bash tool uses. Read at session
	// start, on a mode change, and after any call that needed approval finished (it may have changed git's settings).
	// Until a fresh read: { ok: false }, so every edit asks and git commands are not auto-allowed (fail closed).
	let protect: any = null;
	let protectCwd = "";
	let shell = "unknown";
	const stale = new Set<string>(); // approved calls whose result may change git's settings
	function refresh(cwd: string) {
		protectCwd = cwd;
		try {
			protect = permGit.readGitProtection(cwd);
		} catch (e: any) {
			protect = { ok: false, files: [], dirs: [], error: String((e && e.message) || e) };
		}
		try {
			shell = bashToolShell(cwd);
		} catch {
			shell = "unknown";
		}
	}
	const current = (ctx: any) => {
		if (!protect || protectCwd !== ctx.cwd) refresh(ctx.cwd);
		return protect;
	};

	const show = (ctx: any) => {
		try {
			ctx.ui.setStatus(logic.STATUS_KEY, logic.statusText(mode));
		} catch {
			// status is cosmetic
		}
	};

	// Open approval dialogs. A mode change (or a new session) cancels them (they count as denied) and bumps the
	// generation, so an answer that arrives late can neither allow a call nor leave a grant in the new mode.
	let generation = 0;
	const pending = new Set<AbortController>();
	function cancelPending() {
		generation++;
		for (const c of pending) {
			try {
				c.abort();
			} catch {
				// the answer is discarded by the generation check anyway
			}
		}
		pending.clear();
	}

	pi.on("session_start", async (_event: any, ctx: any) => {
		try {
			const saved = logic.restoreMode(ctx.sessionManager.getBranch());
			mode = saved ?? readLastMode();
		} catch {
			mode = logic.DEFAULT_MODE; // never Trusted when the state can't be read
		}
		cancelPending();
		logic.clearGrants(grants);
		refresh(ctx.cwd);
		show(ctx);
	});

	function setMode(next: string, ctx: any) {
		mode = next;
		cancelPending();
		logic.clearGrants(grants); // "Allow for this chat" is forgotten when the mode changes
		refresh(ctx.cwd);
		try {
			pi.appendEntry(logic.ENTRY_TYPE, { mode: next });
		} catch {
			// the mode still applies to this process
		}
		writeLastMode(next);
		show(ctx);
		try {
			ctx.ui.notify(`Permission mode: ${logic.MODE_LABELS[next]}`, "info");
		} catch {
			// cosmetic
		}
	}

	const modeCommand = {
		description: "Set the permission mode: plan, ask-edits, ask-commands or trusted",
		getArgumentCompletions: (prefix: string) => {
			const items = logic.MODE_IDS.filter((id: string) => id.startsWith((prefix || "").trim().toLowerCase())).map((id: string) => ({ value: id, label: id, description: logic.MODE_LABELS[id] }));
			return items.length ? items : null;
		},
		handler: async (args: string, ctx: any) => {
			let next = logic.parseMode(args);
			if (!next && !(args || "").trim() && ctx.hasUI) {
				const labels: string[] = logic.MODE_IDS.map((id: string) => logic.MODE_LABELS[id]);
				const picked = await ctx.ui.select("Permission mode", labels);
				const i = labels.indexOf(picked as string);
				next = i >= 0 ? logic.MODE_IDS[i] : null;
				if (!next) return;
			}
			if (!next) {
				ctx.ui.notify(`Unknown mode "${String(args || "").trim().slice(0, 40)}". Use: ${logic.MODE_IDS.join(", ")}`, "error");
				return;
			}
			setMode(next, ctx);
		},
	};
	// "/crust-mode" is what the app sends: another extension's own "/mode" cannot make it ambiguous. "/mode" stays for the terminal.
	for (const name of logic.COMMAND_NAMES) pi.registerCommand(name, modeCommand);

	// One question at a time. Parallel tool calls wait their turn and are decided again afterwards, so an
	// "Allow for this chat" answer covers the calls queued behind it.
	let queue: Promise<unknown> = Promise.resolve();

	const judge = (event: any, ctx: any) => logic.decide({ mode, toolName: event.toolName, input: event.input, cwd: ctx.cwd, grants, protect: current(ctx), shell });

	async function review(event: any, ctx: any): Promise<Block | undefined> {
		const d = judge(event, ctx);
		if (d.action === "allow") return sealed(event, d, ctx);
		if (d.action === "block") return { block: true, reason: d.reason };
		if (!ctx.hasUI) return { block: true, reason: "This needs the user's approval, but there is no way to ask here. Nothing was run." };
		const gen = generation;
		const ctl = new AbortController();
		pending.add(ctl);
		let answer: unknown;
		try {
			answer = await ctx.ui.select(d.prompt.title, d.prompt.options, { signal: ctl.signal });
		} finally {
			pending.delete(ctl);
		}
		if (gen !== generation) return { block: true, reason: "The permission mode changed while this was waiting for approval, so the call was cancelled. Nothing was run. Try again." };
		const r = logic.applyAnswer(d, answer, grants);
		if (r.action !== "allow") return { block: true, reason: r.reason };
		// An approved call may change what git runs (a protected file, a command): until it has finished and git's
		// settings were read again, every edit asks and git is not auto-allowed.
		// (An ordinary edit, one that could get "Allow for this chat", is not a git settings file: no re-read needed.)
		if (!(logic.classify(event.toolName) === "edit" && d.grant)) {
			protect = { ok: false, files: [], dirs: [], error: "an approved call is running" };
			if (typeof event.toolCallId === "string") stale.add(event.toolCallId);
			else protect = null; // no id to wait for: read again on the next call
		}
		return sealed(event, { action: "allow" }, ctx);
	}

	// Pi runs the call with the SAME input object, and extensions loaded after this one (user and project extensions
	// come after the app's -e list) still see it. Outside Trusted, the fields the decision read are made read-only, so
	// what was approved is what runs (a later change throws, which blocks the call). Other fields stay writable, so a
	// well-behaved extension can still add a timeout. In Trusted nothing is pinned and no git rewrite is made, but the secret-hiding prefix below is still added. (H4)
	function sealed(event: any, d: any, ctx: any): Block | undefined {
		if (mode !== "trusted" && d && typeof d.rewrite === "string") event.input.command = d.rewrite; // read-only git, hardened (git-harden.js)
		const hidden = hideSecrets(event, ctx);
		if (hidden) return hidden;
		if (mode === "trusted") return undefined;
		pin(event.input, logic.pinKeys(event.toolName));
		return undefined;
	}

	// Pi hands its whole environment to every command it runs, and Pi itself needs its provider keys in it. So the decision above was made
	// on the ORIGINAL command (the prompt and the chat show that one), and the command that actually runs gets a prefix that removes every
	// secret-looking variable present in Pi's environment, by name, for that command only (secret-env.js). Every mode, Trusted included.
	// A shell the prefix can't be written for blocks the call (fail closed) when there is anything to hide.
	function hideSecrets(event: any, ctx: any): Block | undefined {
		if (logic.classify(event.toolName) !== "shell" || !event.input || typeof event.input.command !== "string") return undefined;
		const names = secretEnv.secretNames(process.env, { keep: keepList() });
		if (!names.length) return undefined;
		const family = secretEnv.shellFamily({ toolName: event.toolName, shellPaths: readShellPaths(ctx.cwd) });
		const r = secretEnv.hideCommand(event.input.command, family, names);
		if (!r.ok) return { block: true, reason: r.reason };
		if (r.command !== event.input.command) event.input.command = r.command;
		return undefined;
	}

	pi.on("tool_call", async (event: any, ctx: any): Promise<Block | undefined> => {
		const fail: Block = { block: true, reason: "The permission check failed, so the call was blocked. Ask the user to try again or to switch the permission mode." };
		try {
			// Calls that need no question skip the queue.
			const first = judge(event, ctx);
			if (first.action === "block") return { block: true, reason: first.reason };
			if (first.action === "allow") return sealed(event, first, ctx);
			const run = queue.then(() => review(event, ctx));
			queue = run.catch(() => undefined);
			return await run;
		} catch {
			return fail; // any error, including a dialog that cannot be shown, or input that can't be pinned
		}
	});

	// An approved call finished: read git's settings again before the next decision.
	const reread = (_event: any, ctx: any) => {
		try {
			if (_event && typeof _event.toolCallId === "string" && stale.has(_event.toolCallId)) {
				stale.delete(_event.toolCallId);
				if (!stale.size) refresh(ctx.cwd);
			} else if (!_event || typeof _event.toolCallId !== "string") {
				if (stale.size) {
					stale.clear();
					refresh(ctx.cwd);
				}
			}
		} catch {
			protect = null; // read again on the next call
		}
	};
	pi.on("tool_result", reread);
	pi.on("turn_end", (_e: any, ctx: any) => reread(null, ctx)); // a call that never reported a result
}
