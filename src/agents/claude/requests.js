// Answers for the requests the app sends an agent (phase 7, T8). The app sends { id, type, ...fields } and waits for
// { type:"response", id, command, success, data|error }. Nothing here touches the SDK directly: the adapter hands in `ctx`.
//
// ctx = {
//   state(): { modelId?, effort?, sessionId?, permissionMode?, streaming?, lastAssistantText?, commands? }   what the adapter knows
//   patch(obj): void                        remember { modelId, effort }
//   query: { supportedModels, setModel, interrupt, applyFlagSettings, supportedCommands } | null   the live SDK query (any may be missing)
//   messages(): Promise<stored message[]>   this session's history through the SDK (history.js)
// }
// Served: get_fork_messages and fork (ctx.forkMessages, ctx.fork: the turns of turns.js), get_state, get_available_models, set_model, get_available_thinking_levels, set_thinking_level, abort, get_messages,
// get_commands, get_last_assistant_text. Everything else the app can send answers { success:false, unsupported:true, error }
// with the reason below, never silence. (prompt is the adapter's own: it feeds the input stream. extension_ui_response has no
// response record in the contract and is the permission gate's, so answer() returns null for it.)
"use strict";

const { REQUEST_TYPES } = require("../adapter");

const PROVIDER = "anthropic";
const DEFAULT_LEVELS = [];

// Request type -> why Claude Agent cannot serve it. Capabilities (index.js) say the same in flags; this is the sentence.
const UNSUPPORTED = Object.freeze({
	clear_queue: "Claude Agent runs your message after the current step; there is no queue to clear.",
	compact: "Claude compacts long chats by itself.",
	set_session_name: "Claude Agent chats are named automatically.",
	get_session_stats: "Session statistics are a Pi feature. The header shows the context and the estimated cost.",
	export_html: "Export as HTML is not available for Claude Agent chats.",
	clone: "Cloning a chat is not available for Claude Agent chats yet. /fork from the end of the chat does the same in a new tab.",
});

const ok = (req, data) => ({ type: "response", id: req.id, command: req.type, success: true, ...(data !== undefined ? { data } : {}) });
const fail = (req, error) => ({ type: "response", id: req.id, command: req.type, success: false, error });
const unsupported = (req, error) => ({ ...fail(req, error), unsupported: true });

// ModelInfo (from supportedModels) -> the app's model entry. id is the alias (`value`): that is what setModel takes.
function modelEntry(m) {
	return { provider: PROVIDER, id: m.value, name: m.displayName || m.value, description: m.description, resolvedModel: m.resolvedModel, reasoning: !!m.supportsEffort, effortLevels: Array.isArray(m.supportedEffortLevels) ? m.supportedEffortLevels.slice() : [] };
}

async function loadModels(ctx) {
	const q = ctx.query;
	if (!q || typeof q.supportedModels !== "function") throw new Error("Claude Agent is not running");
	const list = await q.supportedModels();
	return (Array.isArray(list) ? list : []).filter((m) => m && typeof m.value === "string").map(modelEntry);
}

// The model entry the chat is on: the alias it was set to, else the one whose resolved name matches the engine's model.
function currentEntry(models, st) {
	return models.find((m) => m.id === st.modelId) || models.find((m) => m.resolvedModel && m.resolvedModel === st.modelId) || null;
}

async function answer(req, ctx) {
	if (!req || typeof req.type !== "string") return null;
	const st = ctx.state();
	try {
		switch (req.type) {
			case "get_state": {
				let model = null;
				if (st.modelId) {
					let entry = null;
					try {
						entry = currentEntry(await loadModels(ctx), st);
					} catch {}
					model = { provider: PROVIDER, id: entry ? entry.id : st.modelId, name: entry ? entry.name : st.modelId };
				}
				return ok(req, { model, thinkingLevel: st.effort || null, sessionFile: st.sessionId || null, sessionName: st.sessionName || null, isStreaming: !!st.streaming, isCompacting: false, permissionMode: st.permissionMode || null });
			}
			case "get_available_models":
				return ok(req, { models: await loadModels(ctx) });
			case "set_model": {
				const id = req.modelId;
				if (typeof id !== "string" || !id) return fail(req, "No model was given.");
				const models = await loadModels(ctx);
				const m = models.find((x) => x.id === id) || models.find((x) => x.resolvedModel === id);
				if (!m) return fail(req, `Claude does not offer a model called "${id.slice(0, 80)}".`);
				if (typeof ctx.query.setModel !== "function") return unsupported(req, "This Claude Agent engine cannot switch the model.");
				await ctx.query.setModel(m.id);
				ctx.patch({ modelId: m.id });
				return ok(req, { provider: PROVIDER, id: m.id, name: m.name });
			}
			case "get_available_thinking_levels": {
				// Claude calls it effort and cannot switch it off: the list is the model's own, "off" never appears.
				const entry = currentEntry(await loadModels(ctx), st);
				return ok(req, { levels: entry ? entry.effortLevels : DEFAULT_LEVELS });
			}
			case "set_thinking_level": {
				const entry = currentEntry(await loadModels(ctx), st);
				const levels = entry ? entry.effortLevels : DEFAULT_LEVELS;
				if (!levels.includes(req.level)) return fail(req, `"${String(req.level).slice(0, 40)}" is not an effort level of this model (${levels.join(", ") || "none"}).`);
				if (typeof ctx.query.applyFlagSettings !== "function") return unsupported(req, "This Claude Agent engine cannot change the effort level.");
				await ctx.query.applyFlagSettings({ effortLevel: req.level });
				ctx.patch({ effort: req.level });
				return ok(req, { level: req.level });
			}
			case "abort": {
				// interrupt() only asks the turn to stop: the turn ends with its own result (aborted_streaming), the session stays open
				// and the next prompt is a normal turn. The input stream is not closed.
				if (!ctx.query || typeof ctx.query.interrupt !== "function") return fail(req, "Claude Agent is not running");
				await ctx.query.interrupt();
				return ok(req);
			}
			case "get_messages":
				return ok(req, { messages: await ctx.messages() });
			case "get_commands": {
				const q = ctx.query;
				const list = q && typeof q.supportedCommands === "function" ? await q.supportedCommands() : st.commands || [];
				const commands = (Array.isArray(list) ? list : []).filter((c) => c && typeof c.name === "string").map((c) => ({ name: c.name, description: c.description || "", source: "claude", ...(c.argumentHint ? { argumentHint: c.argumentHint } : {}) }));
				return ok(req, { commands });
			}
			case "get_fork_messages":
				return ok(req, { messages: await ctx.forkMessages() });
			case "fork": {
				// In this chat's own tab (rewind, edit and resend): the conversation goes back to before the message. A fork in a new tab is a call of
				// the app's main process (adapter.forkSpec), not a request.
				if (typeof req.entryId !== "string" || !req.entryId) return fail(req, "No message was given to go back to.");
				const r = await ctx.fork(req.entryId);
				return r && r.ok ? ok(req, { text: r.text, cancelled: false }) : fail(req, (r && r.error) || "The conversation could not be rewound.");
			}
			case "get_last_assistant_text":
				return ok(req, { text: st.lastAssistantText || null });
			case "extension_ui_response":
				return null;
			default:
				if (Object.prototype.hasOwnProperty.call(UNSUPPORTED, req.type)) return unsupported(req, UNSUPPORTED[req.type]);
				if (REQUEST_TYPES.includes(req.type)) return null; // prompt: the adapter's own
				return unsupported(req, "Not available for Claude Agent chats.");
		}
	} catch (e) {
		return fail(req, e && e.message ? (ctx.scrub ? ctx.scrub(String(e.message)) : String(e.message)).slice(0, 300) : "The request failed.");
	}
}

module.exports = { answer, modelEntry, UNSUPPORTED, PROVIDER };
