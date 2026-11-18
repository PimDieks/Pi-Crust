// Claude Agent SDK messages -> Pi-shaped records (phase 7, T5). Pure: no Electron, no SDK import, no I/O.
//
// One translator per chat. push(sdkMessage) returns the records (maybe none) that message produces, in order; userMessage()
// returns the row for something the adapter sent itself, because the stream never echoes prompts, images or queued messages.
// The mapping table is section 6 of claude-sdk-capture-findings; shapes are the real ones of SDK 0.3.327.
//
// Not supplied, because the stream does not carry it (nothing is invented): tool_execution_update for ordinary tools, thinking text
// unless the adapter asks for summarized thinking, when a queued message was consumed (and so queue_update), a start event for tool
// execution (the start is the end of the assistant message), per-step output tokens, the context breakdown (crust-context) and the
// permission-mode status (the adapter owns both), retry events beyond the documented fields.
//
// A background subagent (the SDK may start one without being asked): its Agent card stays open past the turn's result and ends at
// system/task_notification; the engine may then start a second turn by itself (origin task-notification), which opens with its
// status/message_start and has no user row.
//
// Records beyond Pi's list (the adapter or the app may ignore them): { type:"claude_session", sessionId, model, permissionMode, skillCount? },
// { type:"auto_retry_end", success, attempt, finalError? } (Pi's own shape, closes auto_retry_start).
// Extras on Pi records: agent_end { costUsd (this turn), totalCostUsd (cumulative for the query) }, agent_settled { aborted },
// tool_execution_end { denied:true } for a refused tool, message_end of an error row { errorCode: <result subtype> }.
"use strict";

// SDK tool name -> the name the app already knows (Pi's). Unknown tools keep their own name. PowerShell is a shell like Bash: the
// card shows its command (renderer toolSummary reads args.command for "bash"). Background-shell helpers (BashOutput, KillShell) and
// Monitor have no command, so they keep their own names.
const TOOL_NAME = { Read: "read", Edit: "edit", Write: "write", Bash: "bash", PowerShell: "bash", Glob: "find", Grep: "grep", Agent: "subagent" };
const STOP_REASON = { end_turn: "stop", stop_sequence: "stop", tool_use: "toolUse", max_tokens: "length", pause_turn: "stop", refusal: "stop" };
const ERROR_TEXT = {
	error_max_turns: "Stopped: the turn limit was reached",
	error_max_budget_usd: "Stopped: the spending limit was reached",
	error_max_structured_output_retries: "Stopped: the structured output kept failing",
	error_during_execution: "The agent stopped with an error",
};

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const toolName = (n) => TOOL_NAME[n] || String(n);

// SDK tool input -> the args the app reads (path, oldText, newText, agent, task).
function mapArgs(sdkName, input) {
	const a = isObj(input) ? { ...input } : {};
	if (sdkName === "Agent") return { agent: a.subagent_type, task: a.description };
	for (const k of ["file_path", "notebook_path"]) {
		if (k in a) {
			a.path = a[k];
			delete a[k];
		}
	}
	if (sdkName === "Edit") {
		if ("old_string" in a) (a.oldText = a.old_string), delete a.old_string;
		if ("new_string" in a) (a.newText = a.new_string), delete a.new_string;
		// Edit's args are { path, oldText, newText }, plus replaceAll only when it is on: the SDK's snake_case replace_all:false is
		// the default and is not carried.
		if ("replace_all" in a) {
			if (a.replace_all === true) a.replaceAll = true;
			delete a.replace_all;
		}
	}
	return a;
}

// A tool_result `content` (string or blocks) -> Pi's result.content.
function resultContent(c) {
	if (typeof c === "string") return [{ type: "text", text: c }];
	if (Array.isArray(c)) return c.filter((b) => isObj(b) && b.type === "text" && typeof b.text === "string").map((b) => ({ type: "text", text: b.text }));
	return [];
}

// Blocks of an SDK assistant message -> Pi's stored message blocks (used for subagent cards).
function piBlocks(content) {
	const out = [];
	for (const b of Array.isArray(content) ? content : []) {
		if (!isObj(b)) continue;
		if (b.type === "text") out.push({ type: "text", text: b.text });
		else if (b.type === "thinking" && b.thinking) out.push({ type: "thinking", thinking: b.thinking });
		else if (b.type === "tool_use") out.push({ type: "toolCall", id: b.id, name: toolName(b.name), arguments: mapArgs(b.name, b.input) });
	}
	return out;
}

function createTranslator(opts = {}) {
	const now = typeof opts.now === "function" ? opts.now : Date.now;
	let turnOpen = false;
	let errorShown = false;
	let sessionKey = null;
	let sessionId = null;
	let cur = null; // the open assistant message: { blocks: Map(index -> block), stopReason, aborted }
	const tools = new Map(); // tool_use id -> { name (SDK), args, startedAt }
	const subs = new Map(); // Agent tool_use id -> { agent, task, messages: [], turns }
	let retry = null; // the open auto-retry: { attempt }
	const early = []; // tool results that arrived before their assistant message closed
	const taskTool = new Map(); // task_id -> Agent tool_use id (a background subagent ends at its task_notification)

	const sub = (id) => {
		if (!subs.has(id)) subs.set(id, { agent: undefined, task: undefined, messages: [], turns: 0 });
		return subs.get(id);
	};
	const subDetails = (id, done, isError) => {
		const s = sub(id);
		return {
			mode: "single",
			results: [{ agent: s.agent, task: s.task, exitCode: done ? (isError ? 1 : 0) : -1, stopReason: done ? "stop" : "toolUse", usage: { turns: s.turns }, messages: s.messages.slice() }],
		};
	};
	const endRetry = (out, success, finalError) => {
		if (!retry) return;
		const r = { type: "auto_retry_end", success, attempt: retry.attempt };
		if (!success && finalError) r.finalError = finalError;
		retry = null;
		out.push(r);
	};
	const startTurn = (out) => {
		if (turnOpen) return;
		turnOpen = true;
		errorShown = false;
		out.push({ type: "agent_start" });
	};
	const errorRow = (out, message, code, detail) => {
		const m = { role: "assistant", content: [], stopReason: "error", errorMessage: message };
		if (code) m.errorCode = code;
		if (detail) m.errorDetail = detail; // the engine's own text, for a details view; never the headline
		out.push({ type: "message_start", message: { role: "assistant", content: [], stopReason: "stop" } }, { type: "message_end", message: m });
		errorShown = true;
	};
	const finishBlock = (b, out, idx) => {
		if (b.type === "text") out.push({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: idx, content: b.text } });
		else if (b.type === "thinking") {
			if (b.text) out.push({ type: "message_update", assistantMessageEvent: { type: "thinking_end", contentIndex: idx, content: b.text } });
		} else if (b.type === "tool_use") {
			if (b.input === undefined) {
				try {
					b.input = b.json ? JSON.parse(b.json) : {};
				} catch {
					b.input = {};
				}
			}
			out.push({
				type: "message_update",
				assistantMessageEvent: { type: "toolcall_end", contentIndex: idx, toolCall: { type: "toolCall", id: b.id, name: toolName(b.name), arguments: mapArgs(b.name, b.input) } },
			});
		}
		b.done = true;
	};
	const closeMessage = (out) => {
		if (!cur) return;
		const content = [];
		const calls = [];
		for (const idx of [...cur.blocks.keys()].sort((a, b) => a - b)) {
			const b = cur.blocks.get(idx);
			if (!b.done) finishBlock(b, out, idx);
			if (b.type === "text") content.push({ type: "text", text: b.text });
			else if (b.type === "thinking" && b.text) content.push({ type: "thinking", thinking: b.text });
			else if (b.type === "tool_use") {
				const args = mapArgs(b.name, b.input);
				content.push({ type: "toolCall", id: b.id, name: toolName(b.name), arguments: args });
				calls.push({ id: b.id, name: b.name, args });
			}
		}
		const stopReason = cur.aborted ? "aborted" : cur.stopReason || "stop";
		out.push({ type: "message_end", message: { role: "assistant", content, stopReason } });
		for (const c of calls) {
			// durationMs counts from here, which includes any wait for the user's approval: the stream carries no moment for the
			// approval (it is the adapter's canUseTool), so the two cannot be told apart in this file.
			tools.set(c.id, { name: c.name, args: c.args, startedAt: now() });
			if (c.name === "Agent") Object.assign(sub(c.id), { agent: c.args.agent, task: c.args.task });
			out.push({ type: "tool_execution_start", toolCallId: c.id, toolName: toolName(c.name), args: c.args });
		}
		cur = null;
		for (const e of early.splice(0)) toolResult(e.m, e.b, out);
	};

	function onStream(m, out) {
		const e = m.event;
		if (!isObj(e) || m.parent_tool_use_id) return;
		switch (e.type) {
			case "message_start":
				endRetry(out, true); // a new message after api_retry: the retry worked
				startTurn(out);
				cur = { blocks: new Map(), stopReason: null, aborted: false };
				out.push({ type: "message_start", message: { role: "assistant", content: [], stopReason: "stop" } });
				break;
			case "content_block_start": {
				if (!cur || !isObj(e.content_block)) break;
				const cb = e.content_block;
				if (cb.type === "text") cur.blocks.set(e.index, { type: "text", text: "" });
				else if (cb.type === "thinking") cur.blocks.set(e.index, { type: "thinking", text: "" });
				else if (cb.type === "tool_use") {
					cur.blocks.set(e.index, { type: "tool_use", id: cb.id, name: cb.name, json: "", input: undefined });
					out.push({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: e.index, id: cb.id, toolName: toolName(cb.name) } });
				}
				break;
			}
			case "content_block_delta": {
				const b = cur && cur.blocks.get(e.index);
				const d = e.delta;
				if (!b || !isObj(d)) break;
				if (d.type === "text_delta" && b.type === "text" && d.text) {
					b.text += d.text;
					out.push({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: e.index, delta: d.text } });
				} else if (d.type === "thinking_delta" && b.type === "thinking" && d.thinking) {
					b.text += d.thinking;
					out.push({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: e.index, delta: d.thinking } });
				} else if (d.type === "input_json_delta" && b.type === "tool_use") b.json += d.partial_json || "";
				break;
			}
			case "content_block_stop": {
				const b = cur && cur.blocks.get(e.index);
				if (b && !b.done) finishBlock(b, out, e.index);
				break;
			}
			case "message_delta":
				if (cur && isObj(e.delta) && e.delta.stop_reason) cur.stopReason = STOP_REASON[e.delta.stop_reason] || "stop";
				break;
			case "message_stop":
				closeMessage(out);
				break;
		}
	}

	function onAssistant(m, out) {
		const msg = m.message;
		if (!isObj(msg)) return;
		if (m.parent_tool_use_id) {
			// A subagent's complete message (no deltas exist for these): it lives on the Agent card.
			const s = sub(m.parent_tool_use_id);
			s.turns++;
			s.messages.push({ role: "assistant", content: piBlocks(msg.content), stopReason: "stop" });
			return;
		}
		if (m.error) {
			startTurn(out);
			const text = resultContent(msg.content).map((b) => b.text).join(" ").trim();
			errorRow(out, text || String(m.error), String(m.error));
			return;
		}
		if (cur && m.aborted) cur.aborted = true;
		if (!cur) return;
		// The complete tool_use carries the full input (the streamed chunks are cut anywhere); take it for the matching block.
		for (const c of Array.isArray(msg.content) ? msg.content : []) {
			if (!isObj(c) || c.type !== "tool_use") continue;
			for (const b of cur.blocks.values()) if (b.type === "tool_use" && b.id === c.id && !b.done) b.input = c.input;
		}
	}

	function onUser(m, out) {
		const content = isObj(m.message) ? m.message.content : null;
		if (!Array.isArray(content)) return;
		for (const b of content) {
			if (!isObj(b) || b.type !== "tool_result") continue;
			if (m.parent_tool_use_id) {
				sub(m.parent_tool_use_id).messages.push({ role: "toolResult", toolCallId: b.tool_use_id, content: resultContent(b.content), isError: !!b.is_error });
				continue;
			}
			// A result can arrive before its assistant message is closed (a background Agent launch, or a fast tool when the model made
			// several calls in one message): the card does not exist yet, so every such result waits for message_stop and is then emitted
			// after the starts, in arrival order. Only a result for a call we never saw at all is dropped (in toolResult).
			if (!tools.has(b.tool_use_id) && cur && [...cur.blocks.values()].some((x) => x.type === "tool_use" && x.id === b.tool_use_id)) {
				early.push({ m, b });
				continue;
			}
			toolResult(m, b, out);
		}
	}

	function toolResult(m, b, out) {
		const t = tools.get(b.tool_use_id);
		if (!t) return; // a result for a call we never saw start: nothing to end
		if (t.name === "Agent" && isObj(m.tool_use_result) && m.tool_use_result.status === "async_launched") {
			// A background subagent: this result only says it was launched. The card stays open until its task_notification,
			// which may arrive after this turn's result, and the card shows it as running.
			t.async = true;
			out.push({
				type: "tool_execution_update",
				toolCallId: b.tool_use_id,
				toolName: "subagent",
				args: t.args,
				partialResult: { content: [{ type: "text", text: "Running in the background" }], details: subDetails(b.tool_use_id, false, false) },
			});
			return;
		}
		tools.delete(b.tool_use_id);
		const isError = !!b.is_error;
		const rec = {
			type: "tool_execution_end",
			toolCallId: b.tool_use_id,
			toolName: toolName(t.name),
			args: t.args,
			result: { content: resultContent(b.content) },
			isError,
			durationMs: Math.max(0, now() - t.startedAt),
		};
		if (t.name === "Agent") rec.result.details = subDetails(b.tool_use_id, true, isError);
		const meta = Array.isArray(m.tool_result_meta) ? m.tool_result_meta.find((x) => isObj(x) && x.id === b.tool_use_id) : null;
		if (meta && meta.permission_decision && meta.permission_decision.decision === "reject") rec.denied = true;
		out.push(rec);
	}

	function onResult(m, out) {
		if (!turnOpen) return; // a local command's result (/compact) or a stray one: no turn to end
		closeMessage(out);
		endRetry(out, !m.is_error, m.is_error ? (Array.isArray(m.errors) && m.errors[0]) || (typeof m.result === "string" ? m.result : "") || ERROR_TEXT[m.subtype] : undefined);
		const aborted = m.terminal_reason === "aborted_streaming";
		if (m.is_error && !aborted && !errorShown) {
			const text = Array.isArray(m.errors) && m.errors.length ? m.errors.join("; ") : typeof m.result === "string" && m.result ? m.result : ERROR_TEXT[m.subtype] || `The agent stopped with an error (${m.subtype})`;
			// error_during_execution carries engine diagnostics ("[ede_diagnostic] ..."): a plain sentence is the message, the raw text is the detail.
			const plain = m.subtype === "error_during_execution" || /\[ede_diagnostic\]/.test(text);
			errorRow(out, plain ? ERROR_TEXT.error_during_execution : m.subtype && ERROR_TEXT[m.subtype] ? ERROR_TEXT[m.subtype] : text, m.subtype, plain ? text : undefined);
		}
		// A call still open at the end of the turn never got its result (interrupt, crash): its card ends as an error, never silently.
		for (const [id, t] of [...tools]) {
			if (t.async) continue; // a background subagent outlives the turn
			tools.delete(id);
			const rec = {
				type: "tool_execution_end",
				toolCallId: id,
				toolName: toolName(t.name),
				args: t.args,
				result: { content: [{ type: "text", text: aborted ? "Stopped before this finished" : "The turn ended before this finished" }] },
				isError: true,
				durationMs: Math.max(0, now() - t.startedAt),
			};
			if (t.name === "Agent") rec.result.details = subDetails(id, true, true);
			out.push(rec);
		}
		const end = { type: "agent_end", messages: [] };
		if (isObj(m.model_usage_since_last_result)) end.costUsd = Object.values(m.model_usage_since_last_result).reduce((s, u) => s + (isObj(u) && typeof u.costUSD === "number" ? u.costUSD : 0), 0);
		if (typeof m.total_cost_usd === "number") end.totalCostUsd = m.total_cost_usd;
		out.push(end);
		out.push(aborted ? { type: "agent_settled", aborted: true } : { type: "agent_settled" });
		turnOpen = false;
	}

	function onSystem(m, out) {
		switch (m.subtype) {
			case "init": {
				sessionId = typeof m.session_id === "string" ? m.session_id : sessionId;
				const key = JSON.stringify([m.session_id, m.model, m.permissionMode]);
				if (key !== sessionKey) {
					sessionKey = key;
					const rec = { type: "claude_session", sessionId: m.session_id, model: m.model, permissionMode: m.permissionMode };
					if (Array.isArray(m.skills)) rec.skillCount = m.skills.length; // getContextUsage has no skill count; the init list does
					out.push(rec);
				}
				break;
			}
			case "status":
				if (m.status === "requesting") startTurn(out);
				break;
			case "api_retry": {
				const status = m.error_status ? ` (${m.error_status})` : "";
				retry = { attempt: m.attempt };
				out.push({ type: "auto_retry_start", attempt: m.attempt, maxAttempts: m.max_retries, errorMessage: `${m.error || "error"}${status}` });
				break;
			}
			case "task_progress":
				if (m.tool_use_id) {
					const s = sub(m.tool_use_id);
					if (!s.agent && m.subagent_type) s.agent = m.subagent_type;
					const t = tools.get(m.tool_use_id);
					out.push({
						type: "tool_execution_update",
						toolCallId: m.tool_use_id,
						toolName: "subagent",
						args: t ? t.args : { agent: s.agent, task: s.task },
						partialResult: { content: [{ type: "text", text: String(m.description || "") }], details: subDetails(m.tool_use_id, false, false) },
					});
				}
				break;
			case "task_notification": {
				const id = m.tool_use_id || taskTool.get(m.task_id);
				const t = id && tools.get(id);
				if (!t || !t.async) break; // foreground subagents ended with their tool result
				tools.delete(id);
				taskTool.delete(m.task_id);
				const isError = m.status !== undefined && m.status !== "completed";
				const text = typeof m.summary === "string" ? m.summary : "";
				const rec = { type: "tool_execution_end", toolCallId: id, toolName: "subagent", args: t.args, result: { content: text ? [{ type: "text", text }] : [] }, isError, durationMs: Math.max(0, now() - t.startedAt) };
				rec.result.details = subDetails(id, true, isError);
				out.push(rec);
				break;
			}
			case "task_started":
				if (m.task_id && m.tool_use_id) taskTool.set(m.task_id, m.tool_use_id);
				if (m.tool_use_id) {
					const s = sub(m.tool_use_id);
					if (!s.agent) s.agent = m.subagent_type;
					if (!s.task) s.task = m.description;
				}
				break;
		}
	}

	return {
		get sessionId() {
			return sessionId;
		},
		// Feed one raw SDK message; returns Pi records. Unknown or malformed messages return [].
		push(m) {
			const out = [];
			if (!isObj(m)) return out;
			switch (m.type) {
				case "system":
					onSystem(m, out);
					break;
				case "stream_event":
					onStream(m, out);
					break;
				case "assistant":
					onAssistant(m, out);
					break;
				case "user":
					onUser(m, out);
					break;
				case "result":
					onResult(m, out);
					break;
			}
			return out;
		},
		// The adapter sent a prompt (or a queued message). The stream never echoes it, so this returns its row;
		// it opens the turn when none is open. Images: [{ data (base64), mimeType }].
		userMessage({ text = "", images = [] } = {}) {
			const out = [];
			startTurn(out);
			const content = [];
			if (text) content.push({ type: "text", text });
			for (const im of images) if (isObj(im)) content.push({ type: "image", data: im.data, mimeType: im.mimeType });
			const message = { role: "user", content };
			out.push({ type: "message_start", message }, { type: "message_end", message });
			return out;
		},
	};
}

module.exports = { createTranslator, TOOL_NAME, STOP_REASON, toolName, mapArgs, piBlocks, resultContent };
