"use strict";
// Pi's tool `show_in_viewer` (spec: Viewer tabs and project files, task 13). Registered by src/pi-extension/crust-guard.ts, which Pi Crust
// already loads into every chat's Pi (so Pi's start arguments stay as they were). Plain CommonJS and no Pi imports, so a node test runs it
// (scripts/viewer-agent.test.js); the schema is plain JSON Schema, which Pi's validator reads like a TypeBox one.
//
// The tool decides nothing. It sends the model's text to the app with one dialog of Pi's RPC extension protocol, an "input" titled TITLE, and
// the app (src/main.js answerViewerRequest -> viewer-agent-main.js) checks the path or the address and opens the tab. Before this runs, the
// permission extension (permission-modes.ts, the shared rule in permission-logic.js decideShow) has already judged the call like a read of the
// file in the chat's current mode: allowed, or refused with a reason; this tool never asks the person anything.
// A refusal comes back as a failed tool call (the thrown message is the tool's result), so the model reads the reason.
const TITLE = "crust:show_in_viewer";
const NAME = "show_in_viewer";
const ANSWER_TIMEOUT_MS = 15000;
const MAX_SENT = 2000;

const DESCRIPTION =
	"Show something in the person's Viewer panel: a file of the open project, or a page on localhost. It opens in a new tab in the background " +
	"and does not take their focus (they see a badge on the Viewer tab). Use it to point at a page, image, SVG or PDF you made or mean. " +
	"target is a file path relative to the project root (or absolute, inside the project), or a localhost address (http or https on localhost, " +
	"127.0.0.1 or [::1], any port). Nothing else is shown: no other host, no file outside the project, no file or folder starting with a dot, " +
	"and only web pages (HTML), images and PDFs. At 8 open pages it is refused. The result says what happened or why it was refused.";

function createTool() {
	return {
		name: NAME,
		label: "Show in Viewer",
		description: DESCRIPTION,
		parameters: {
			type: "object",
			properties: { target: { type: "string", description: "A project file path, or a localhost address." } },
			required: ["target"],
			additionalProperties: false,
		},
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const target = params && typeof params.target === "string" ? params.target : "";
			if (!ctx || ctx.mode !== "rpc" || !ctx.hasUI) throw new Error("The Viewer can only be reached from a chat in Pi Crust.");
			let answer;
			try {
				answer = await ctx.ui.input(TITLE, target.slice(0, MAX_SENT), { signal, timeout: ANSWER_TIMEOUT_MS });
			} catch {
				answer = undefined;
			}
			let r = null;
			try {
				r = typeof answer === "string" ? JSON.parse(answer) : null;
			} catch {
				r = null;
			}
			if (!r || typeof r.ok !== "boolean" || typeof r.text !== "string") throw new Error("The Viewer did not answer, so nothing was shown.");
			if (!r.ok) throw new Error(r.text);
			return { content: [{ type: "text", text: r.text }], details: { shown: true } };
		},
	};
}

// pi.registerTool when it exists (an old Pi without it: no tool, nothing else changes).
function register(pi) {
	if (!pi || typeof pi.registerTool !== "function") return false;
	pi.registerTool(createTool());
	return true;
}

module.exports = { TITLE, NAME, DESCRIPTION, createTool, register };
