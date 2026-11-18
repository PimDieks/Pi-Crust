// Stand-in for @anthropic-ai/claude-agent-sdk (tests and offscreen runs only; PI_CRUST_CLAUDE_SDK=<this file>, unpackaged app only).
// query({ prompt, options }) replays scripted messages after the first user message and logs what it was given. The log never holds
// a key: options.env is reduced to { ANTHROPIC_API_KEY: "key present" | "key absent", names: [...] }.
// Script: PI_CRUST_CLAUDE_SCRIPT=<json file with an array of messages>, or setScript([...]). Log: the exported `calls`, and
// PI_CRUST_CLAUDE_SDK_LOG=<file> (JSON lines) when set.
import fs from "node:fs";

export const calls = [];
let script = null;
export function setScript(s) {
	script = s;
}
export function reset() {
	calls.length = 0;
	script = null;
}

const DEFAULT_SCRIPT = [
	{ type: "system", subtype: "init", session_id: "stand-in-session" },
	{ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "ok" } } },
	{ type: "result", subtype: "success", is_error: false, result: "ok", total_cost_usd: 0.01, session_id: "stand-in-session" },
];

// The options as logged: functions by name, the env reduced to names and "key present".
export function describeOptions(o = {}) {
	const out = {};
	for (const [k, v] of Object.entries(o)) {
		if (k === "env") out.env = { ANTHROPIC_API_KEY: v && v.ANTHROPIC_API_KEY ? "key present" : "key absent", names: Object.keys(v || {}).sort(), CLAUDE_CONFIG_DIR: v && v.CLAUDE_CONFIG_DIR };
		else if (typeof v === "function") out[k] = "[function]";
		else out[k] = v;
	}
	return out;
}

export function query({ prompt, options }) {
	const entry = { options: describeOptions(options), rawEnvHasKey: !!(options && options.env && options.env.ANTHROPIC_API_KEY), calls: [], closed: false, interrupted: 0, modes: [] };
	calls.push(entry);
	if (process.env.PI_CRUST_CLAUDE_SDK_LOG) fs.appendFileSync(process.env.PI_CRUST_CLAUDE_SDK_LOG, JSON.stringify({ options: entry.options }) + "\n");
	const messages = script || (process.env.PI_CRUST_CLAUDE_SCRIPT ? JSON.parse(fs.readFileSync(process.env.PI_CRUST_CLAUDE_SCRIPT, "utf8")) : DEFAULT_SCRIPT);
	let stopWait = null;
	async function* run() {
		const it = typeof prompt === "string" ? null : prompt[Symbol.asyncIterator]();
		if (it) {
			const first = await Promise.race([it.next(), new Promise((r) => (stopWait = () => r({ done: true })))]);
			if (first.done || entry.closed) return;
			entry.calls.push("user_message");
		}
		for (const m of messages) {
			if (entry.closed) return;
			yield m;
		}
		// Streaming input stays open until closed, like the real one.
		if (it) await new Promise((r) => (stopWait = r));
	}
	const gen = run();
	gen.initializationResult = async () => ({ commands: [], models: [], account: {} });
	gen.interrupt = async () => void entry.interrupted++;
	gen.setPermissionMode = async (m) => void entry.modes.push(m);
	gen.setModel = async () => {};
	gen.close = () => {
		entry.closed = true;
		if (stopWait) stopWait();
	};
	return gen;
}
