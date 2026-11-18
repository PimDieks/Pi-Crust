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

type Block = { block: true; reason: string };

// "Last chosen" mode, so a new chat starts where the user left off. A new install has no file: Ask before commands.
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
		fs.writeFileSync(f, JSON.stringify({ mode }));
	} catch {
		// not saving is harmless: the next new chat starts in the default
	}
}

export default function (pi: ExtensionAPI) {
	if (typeof (pi as any).on !== "function" || typeof (pi as any).registerCommand !== "function") return; // old Pi: stay inactive, the app shows why

	let mode: string = logic.DEFAULT_MODE; // strict until session_start says otherwise
	const grants = logic.createGrants();

	const show = (ctx: any) => {
		try {
			ctx.ui.setStatus(logic.STATUS_KEY, logic.statusText(mode));
		} catch {
			// status is cosmetic
		}
	};

	pi.on("session_start", async (_event: any, ctx: any) => {
		try {
			const saved = logic.restoreMode(ctx.sessionManager.getBranch());
			mode = saved ?? readLastMode();
		} catch {
			mode = logic.DEFAULT_MODE; // never Trusted when the state can't be read
		}
		logic.clearGrants(grants);
		show(ctx);
	});

	function setMode(next: string, ctx: any) {
		mode = next;
		logic.clearGrants(grants); // "Allow for this chat" is forgotten when the mode changes
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

	pi.registerCommand("mode", {
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
	});

	// One question at a time. Parallel tool calls wait their turn and are decided again afterwards, so an
	// "Allow for this chat" answer covers the calls queued behind it.
	let queue: Promise<unknown> = Promise.resolve();

	async function review(event: any, ctx: any): Promise<Block | undefined> {
		const d = logic.decide({ mode, toolName: event.toolName, input: event.input, cwd: ctx.cwd, grants });
		if (d.action === "allow") return undefined;
		if (d.action === "block") return { block: true, reason: d.reason };
		if (!ctx.hasUI) return { block: true, reason: "This needs the user's approval, but there is no way to ask here. Nothing was run." };
		const answer = await ctx.ui.select(d.prompt.title, d.prompt.options);
		const r = logic.applyAnswer(d, answer, grants);
		return r.action === "allow" ? undefined : { block: true, reason: r.reason };
	}

	pi.on("tool_call", async (event: any, ctx: any): Promise<Block | undefined> => {
		const fail: Block = { block: true, reason: "The permission check failed, so the call was blocked. Ask the user to try again or to switch the permission mode." };
		try {
			// Calls that need no question skip the queue.
			const first = logic.decide({ mode, toolName: event.toolName, input: event.input, cwd: ctx.cwd, grants });
			if (first.action !== "ask") return first.action === "allow" ? undefined : { block: true, reason: first.reason };
			const run = queue.then(() => review(event, ctx));
			queue = run.catch(() => undefined);
			return await run;
		} catch {
			return fail; // any error, including a dialog that cannot be shown
		}
	});
}
