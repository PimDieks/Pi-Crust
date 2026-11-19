#!/usr/bin/env node
// Scripted stand-in for Pi, for the self-test step `viewer-agent` ONLY (scripts/viewer-agent-selftest.js sets PI_CRUST_PI to this file). A script,
// like scripts/char/fake-agent.js: never installed, renamed or shipped as a program, never reads ~/.pi or an auth file, never calls a model.
// It speaks Pi's JSONL RPC and plays one thing: a prompt "show: <target> | <target> ..." makes it call the tool show_in_viewer for each target, the way
// the real Pi would, with the REAL pieces of the app in the loop:
//   - the permission extension's decision: the shared logic (src/permission-logic.js decide) in the mode the app set with "/crust-mode <id>" (the stand-in
//     answers it with the same status record), a refusal becoming the tool's failed result with the logic's reason;
//   - the tool itself: src/pi-viewer-tool.js execute(), whose ctx.ui.input is a real extension_ui_request / extension_ui_response round trip with the app.
// So what is NOT real is only Pi itself (the model, the tool loop). Records follow the shapes of scripts/char/transcripts/tool-turn.json.
"use strict";

const path = require("node:path");
const crypto = require("node:crypto");
const logic = require("../src/permission-logic");
const piTool = require("../src/pi-viewer-tool");

const argv = process.argv.slice(2);
const sessionArg = argv.indexOf("--session") >= 0 ? argv[argv.indexOf("--session") + 1] : null;
const state = {
	model: { provider: "stand-in", id: "stand-in-1", name: "Stand-in" },
	thinkingLevel: "off",
	isStreaming: false,
	sessionFile: sessionArg || path.join(process.env.PI_CODING_AGENT_DIR || process.cwd(), "viewer-agent-session.jsonl"),
	messageCount: 0,
};
const defaults = {
	get_state: state,
	get_messages: { messages: [] },
	get_available_models: { models: [state.model] },
	clear_queue: { steering: [], followUp: [] },
};
let mode = logic.DEFAULT_MODE;
const tool = piTool.createTool();
const waiters = new Map(); // ui request id -> resolve

const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const status = () => out({ type: "extension_ui_request", id: crypto.randomUUID(), method: "setStatus", statusKey: logic.STATUS_KEY, statusText: logic.statusText(mode) });
// The context a tool's execute() gets in Pi's RPC mode: dialogs are a request to the app and a wait for its response.
const ctx = {
	mode: "rpc",
	hasUI: true,
	cwd: process.cwd(),
	ui: {
		input: (title, placeholder, opts) =>
			new Promise((resolve) => {
				const id = crypto.randomUUID();
				const timer = opts && opts.timeout ? setTimeout(() => (waiters.delete(id), resolve(undefined)), opts.timeout) : null;
				waiters.set(id, (r) => {
					if (timer) clearTimeout(timer);
					resolve("cancelled" in r && r.cancelled ? undefined : "value" in r ? r.value : undefined);
				});
				out({ type: "extension_ui_request", id, method: "input", title, placeholder, timeout: opts && opts.timeout });
			}),
	},
};

let seq = 0;
async function call(target) {
	const id = `tc-${++seq}`;
	const args = { target };
	out({ type: "message_start", message: { role: "assistant", content: [], stopReason: "stop" } });
	out({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, id, toolName: "show_in_viewer" } });
	out({ type: "message_update", assistantMessageEvent: { type: "toolcall_end", contentIndex: 0, toolCall: { type: "toolCall", id, name: "show_in_viewer", arguments: args } } });
	out({ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", id, name: "show_in_viewer", arguments: args }], stopReason: "toolUse" } });
	out({ type: "tool_execution_start", toolCallId: id, toolName: "show_in_viewer", args });
	const started = Date.now();
	let text;
	let isError = false;
	// The permission extension's tool_call hook: the same shared decision, never a question for this tool.
	const d = logic.decide({ mode, toolName: "show_in_viewer", input: args, cwd: process.cwd(), grants: logic.createGrants() });
	if (d.action !== "allow") {
		text = d.action === "block" ? d.reason : "The permission check failed.";
		isError = true;
	} else {
		try {
			const r = await tool.execute(id, args, new AbortController().signal, null, ctx);
			text = r.content[0].text;
		} catch (e) {
			text = String((e && e.message) || e);
			isError = true;
		}
	}
	out({ type: "tool_execution_end", toolCallId: id, toolName: "show_in_viewer", args, result: { content: [{ type: "text", text }] }, isError, durationMs: Date.now() - started });
}

async function turn(message) {
	out({ type: "agent_start" });
	out({ type: "message_start", message: { role: "user", content: [{ type: "text", text: message }] } });
	out({ type: "message_end", message: { role: "user", content: [{ type: "text", text: message }] } });
	for (const t of message.replace(/^show:\s*/, "").split("|")) await call(t.trim());
	out({ type: "message_start", message: { role: "assistant", content: [], stopReason: "stop" } });
	out({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Done." } });
	out({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "Done." } });
	out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Done." }], stopReason: "stop" } });
	out({ type: "agent_end", messages: [] });
	out({ type: "agent_settled" });
}

let chain = Promise.resolve();
function handle(req) {
	if (req.type === "extension_ui_response") {
		const w = waiters.get(req.id);
		if (w) (waiters.delete(req.id), w(req));
		return;
	}
	let data = defaults[req.type] ?? null;
	if (req.type === "prompt") data = null;
	out({ type: "response", id: req.id, command: req.type, success: true, data });
	if (req.type !== "prompt" || typeof req.message !== "string") return;
	const m = /^\/crust-mode\s+(\S+)/.exec(req.message);
	if (m) {
		if (logic.isMode(m[1])) mode = m[1];
		status();
		return;
	}
	if (/^show:/.test(req.message)) chain = chain.then(() => turn(req.message)).catch((e) => process.stderr.write(`viewer-agent-fake-pi: ${e && e.stack}\n`));
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buf += chunk;
	let nl;
	while ((nl = buf.indexOf("\n")) >= 0) {
		const line = buf.slice(0, nl);
		buf = buf.slice(nl + 1);
		if (!line.trim()) continue;
		try {
			handle(JSON.parse(line));
		} catch {
			// not a record: ignored
		}
	}
});
process.stdin.on("end", () => process.exit(0));
status(); // like the permission extension at session start
