// Loaded only by Pi Crust (`pi --mode rpc -e <this file>`). Runaway guard: asks the user to continue after
// every N tool calls in one run (PI_CRUST_TOOL_CHECKIN, 0 = off) and blocks a call repeated 5 times in a row. It also registers the tool show_in_viewer.
// The decisions live in ../guard-logic.js (unit tested).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
// @ts-ignore plain CommonJS module
import { createGuard, parseThreshold } from "../guard-logic.js";
// @ts-ignore plain CommonJS module
import * as viewerTool from "../pi-viewer-tool.js";

export default function (pi: ExtensionAPI) {
	// The tool show_in_viewer rides in this file so Pi's start arguments stay unchanged (see ../pi-viewer-tool.js); the permission extension judges it.
	try {
		viewerTool.register(pi);
	} catch {
		// the guard below matters more than the tool
	}
	const n = parseThreshold(process.env.PI_CRUST_TOOL_CHECKIN, 40);
	const guard = createGuard(n);

	pi.on("agent_start", async () => {
		guard.start();
	});

	// Parallel tool calls share one "Keep going?" question and its answer.
	let pending: Promise<{ block: true; reason: string } | undefined> | null = null;

	pi.on("tool_call", async (event, ctx) => {
		if ((event as any).parentToolCallId) return undefined; // nested call from a script: not counted
		if (pending) return pending;
		const d = guard.check(event.toolName, event.input);
		if (d.action === "block") return { block: true, reason: d.reason };
		if (d.action === "allow") return undefined;
		if (!ctx.hasUI) return undefined; // nobody to ask: don't block
		pending = (async () => {
			let keepGoing = true;
			try {
				keepGoing = await ctx.ui.confirm("Long run", `The agent has made ${d.count} tool calls for this prompt. Keep going?`);
			} catch {
				keepGoing = true; // errors and timeouts must not break the session
			}
			const r = d.resolve(keepGoing);
			return r.action === "block" ? { block: true as const, reason: r.reason as string } : undefined;
		})();
		try {
			return await pending;
		} finally {
			pending = null;
		}
	});
}
