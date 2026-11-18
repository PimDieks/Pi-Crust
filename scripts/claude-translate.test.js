"use strict";
// Claude SDK message translation (phase 7, T5): recorded real streams (normalised, scripts/claude-fixtures/*.jsonl) replayed through
// src/agents/claude/translate.js and compared record by record with golden files. No Electron, no SDK, no model.
// CLAUDE_TRANSLATE_UPDATE=1 rewrites the goldens (review the diff before committing).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { createTranslator } = require("../src/agents/claude/translate");

const DIR = path.join(__dirname, "claude-fixtures");
const load = (name) => fs.readFileSync(path.join(DIR, `${name}.jsonl`), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const clock = () => {
	let t = 1000;
	return () => (t += 7);
};

// What the adapter sent, by position: { <index of the message it came before>: userMessage args }. The stream never echoes these.
const SENDS = {
	read: { 0: { text: "Read notes.txt and tell me what it says." } },
	"edit-allow": { 0: { text: "In notes.txt change apple to pear." } },
	"edit-deny": { 0: { text: "In notes.txt change apple to pear." } },
	interrupt: { 0: { text: "Write a long story." } },
	queue: { 0: { text: "Read data.txt and count the lines." }, 3: { text: "Also end your final answer with the word DONE." } },
	"thinking-subagent": { 0: { text: "Use a checker subagent to count the lines of data.txt." } },
	// After an interrupt the same session takes a second prompt (index 19 is its repeated init).
	"interrupt-continue": { 0: { text: "Count from 1 to 200." }, 19: { text: "Reply with the single word: ready." } },
	// A background subagent: the one prompt gives two results; the second turn is unprompted (no send for it).
	"subagent-background": { 0: { text: "Use a subagent to append a line to notes.txt." } },
};

function run(name, messages = load(name)) {
	const tr = createTranslator({ now: clock() });
	const out = [];
	messages.forEach((m, i) => {
		const s = SENDS[name] && SENDS[name][i];
		if (s) out.push(...tr.userMessage(s));
		out.push(...tr.push(m));
	});
	return out;
}
const goldenPath = (n) => path.join(DIR, `${n}.golden.jsonl`);
const readGolden = (n) => fs.readFileSync(goldenPath(n), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const types = (recs) => recs.map((r) => r.type);

for (const name of Object.keys(SENDS)) {
	test(`${name}: replay equals the golden, record by record`, () => {
		const got = run(name);
		if (process.env.CLAUDE_TRANSLATE_UPDATE) fs.writeFileSync(goldenPath(name), got.map((r) => JSON.stringify(r)).join("\n") + "\n");
		const want = readGolden(name);
		assert.equal(got.length, want.length, `record count (${types(got).join(",")})`);
		got.forEach((r, i) => assert.deepEqual(r, want[i], `record ${i} (${r.type})`));
	});
}

test("shape checks on the goldens that do not depend on the golden file itself", () => {
	const read = run("read");
	assert.deepEqual(types(read).slice(0, 4), ["agent_start", "message_start", "message_end", "claude_session"]);
	assert.equal(read[0].type, "agent_start");
	assert.equal(types(read).filter((t) => t === "agent_start").length, 1, "requesting status does not open a second turn");
	const end = read.find((r) => r.type === "tool_execution_end");
	assert.equal(end.toolName, "read");
	assert.equal(end.isError, false);
	assert.equal(end.args.path, "C:\\work\\proj\\notes.txt", "file_path becomes path, from the complete assistant message");
	const ae = read.find((r) => r.type === "agent_end");
	assert.ok(ae.totalCostUsd > 0 && ae.costUsd > 0);
	assert.equal(types(read).slice(-2).join(), "agent_end,agent_settled");

	const deny = run("edit-deny").find((r) => r.type === "tool_execution_end" && r.toolName === "edit");
	assert.equal(deny.isError, true);
	assert.equal(deny.denied, true);

	const allow = run("edit-allow").find((r) => r.type === "tool_execution_end" && r.toolName === "edit");
	assert.ok(!("denied" in allow));
	assert.equal(allow.toolName, "edit");
	assert.ok("oldText" in allow.args && "newText" in allow.args);

	const intr = run("interrupt");
	assert.deepEqual(intr.at(-1), { type: "agent_settled", aborted: true });
	assert.equal(intr.filter((r) => r.type === "message_end").pop().message.stopReason, "aborted");
	assert.ok(!intr.some((r) => r.message && r.message.stopReason === "error"), "an interrupt is not an error row");

	const queue = run("queue");
	assert.equal(queue.filter((r) => r.type === "agent_start").length, 1);
	assert.equal(queue.filter((r) => r.type === "agent_end").length, 1, "one result for the merged message");
	assert.equal(queue.filter((r) => r.type === "message_start" && r.message.role === "user").length, 2, "both sends have a row");

	const sub = run("thinking-subagent");
	assert.ok(sub.some((r) => r.type === "message_update" && r.assistantMessageEvent.type === "thinking_delta"));
	assert.ok(sub.some((r) => r.type === "tool_execution_update" && r.toolName === "subagent"));
	const sEnd = sub.find((r) => r.type === "tool_execution_end" && r.toolName === "subagent");
	assert.equal(sEnd.result.details.results[0].agent, "checker");
	assert.ok(sEnd.result.details.results[0].messages.length >= 2);
	assert.ok(!sub.some((r) => r.type === "tool_execution_start" && r.toolName === "read"), "inner subagent calls are not top-level tools");
});

test("session id is reported once, not again for an identical init", () => {
	const tr = createTranslator();
	const init = load("read")[0];
	assert.equal(tr.push(init).length, 1);
	assert.equal(tr.push(init).length, 0);
	assert.equal(tr.sessionId, init.session_id);
});

test("retry, error result, budget stop, assistant error", () => {
	const tr = createTranslator();
	assert.deepEqual(tr.push({ type: "system", subtype: "api_retry", attempt: 2, max_retries: 5, retry_delay_ms: 1000, error_status: 529, error: "overloaded" }), [
		{ type: "auto_retry_start", attempt: 2, maxAttempts: 5, errorMessage: "overloaded (529)" },
	]);
	tr.userMessage({ text: "x" });
	const out = tr.push({ type: "result", subtype: "error_max_budget_usd", is_error: true, total_cost_usd: 0.5, errors: [] });
	assert.deepEqual(types(out), ["message_start", "message_end", "agent_end", "agent_settled"]);
	assert.equal(out[1].message.stopReason, "error");
	assert.match(out[1].message.errorMessage, /spending limit/);
	assert.equal(out[1].message.errorCode, "error_max_budget_usd");
	assert.equal(out[2].totalCostUsd, 0.5);

	const t2 = createTranslator();
	t2.userMessage({ text: "x" });
	const a = t2.push({ type: "assistant", error: "authentication_failed", message: { content: [{ type: "text", text: "Invalid API key" }] } });
	assert.equal(a[1].message.errorMessage, "Invalid API key");
	const r = t2.push({ type: "result", subtype: "success", is_error: true, result: "Invalid API key" });
	assert.deepEqual(types(r), ["agent_end", "agent_settled"], "the error row is not shown twice");

	// a result with no turn open (a local command) ends nothing
	assert.deepEqual(createTranslator().push({ type: "result", subtype: "success", num_turns: 0, local_command: "compact" }), []);
});

test("userMessage: prompt row with an image; a send while a turn is open adds no second agent_start", () => {
	const tr = createTranslator();
	const first = tr.userMessage({ text: "look", images: [{ data: "AAAA", mimeType: "image/png" }] });
	assert.deepEqual(types(first), ["agent_start", "message_start", "message_end"]);
	assert.deepEqual(first[1].message.content, [{ type: "text", text: "look" }, { type: "image", data: "AAAA", mimeType: "image/png" }]);
	assert.deepEqual(types(tr.userMessage({ text: "more" })), ["message_start", "message_end"]);
});

test("negative controls: swapping two messages and dropping a tool result both change the output", () => {
	for (const name of ["read", "edit-allow"]) {
		const base = JSON.stringify(run(name));
		const msgs = load(name);
		const iUser = msgs.findIndex((m) => m.type === "user");
		const iAssistant = msgs.findIndex((m) => m.type === "assistant");

		const swapped = msgs.slice();
		[swapped[iAssistant], swapped[iUser]] = [swapped[iUser], swapped[iAssistant]];
		assert.notEqual(JSON.stringify(run(name, swapped)), base, `${name}: swap of assistant and tool result`);

		const deltas = msgs.map((m, i) => [m, i]).filter(([m]) => m.type === "stream_event" && m.event.delta && m.event.delta.type === "text_delta");
		if (deltas.length >= 2) {
			const sw = msgs.slice();
			[sw[deltas[0][1]], sw[deltas[1][1]]] = [sw[deltas[1][1]], sw[deltas[0][1]]];
			assert.notEqual(JSON.stringify(run(name, sw)), base, `${name}: swap of two text deltas`);
		}

		const dropped = msgs.filter((m) => !(m.type === "user" && m.message.content.some((b) => b.type === "tool_result")));
		const out = run(name, dropped);
		assert.notEqual(JSON.stringify(out), base, `${name}: dropped tool result`);
		assert.ok(!out.some((r) => r.type === "tool_execution_end"));
	}
	// and the comparison used by the golden tests sees it
	const want = readGolden("read");
	const msgs = load("read");
	const dropped = msgs.filter((m) => m.type !== "user");
	const got = run("read", dropped);
	assert.ok(got.length !== want.length || got.some((r, i) => JSON.stringify(r) !== JSON.stringify(want[i])));
});

test("unknown or malformed messages are ignored without a throw and change nothing", () => {
	const junk = [null, undefined, 5, "x", [], {}, { type: "rate_limit_event" }, { type: "tool_progress", x: 1 }, { type: "system", subtype: "hook_started" }, { type: "system" }, { type: "stream_event" }, { type: "stream_event", event: { type: "future_event" } }, { type: "user" }, { type: "assistant" }, { type: "result" }];
	const tr = createTranslator();
	for (const j of junk) assert.deepEqual(tr.push(j), [], JSON.stringify(j));
	const msgs = load("read");
	const mixed = [];
	for (const m of msgs) mixed.push(m, { type: "rate_limit_event" }, { type: "system", subtype: "hook_started" });
	const want = JSON.stringify(run("read", msgs));
	// SENDS are positional, so replay by hand with the same send
	const t2 = createTranslator({ now: clock() });
	const out = [...t2.userMessage(SENDS.read[0])];
	for (const m of mixed) out.push(...t2.push(m));
	assert.equal(JSON.stringify(out), want);
});

test("background subagent: its card stays open past the first result and ends at task_notification; the unprompted turn has no user row", () => {
	const out = run("subagent-background");
	const t = types(out);
	assert.equal(t.filter((x) => x === "agent_start").length, 2, "the engine's own second turn opens a turn");
	assert.equal(t.filter((x) => x === "agent_end").length, 2);
	assert.equal(t.filter((x) => x === "agent_settled").length, 2);
	assert.equal(out.filter((r) => r.type === "message_start" && r.message.role === "user").length, 1, "no user row for the unprompted turn");
	const firstEnd = t.indexOf("agent_end");
	const subEnd = out.findIndex((r) => r.type === "tool_execution_end" && r.toolName === "subagent");
	assert.ok(subEnd > firstEnd, "the card ends after the first turn closed");
	assert.equal(out.filter((r) => r.type === "tool_execution_end" && r.toolName === "subagent").length, 1, "ended once");
	assert.equal(out[subEnd].isError, false);
	assert.ok(out[subEnd].result.details.results[0].messages.length >= 2, "the inner messages that arrived after the first result are on the card");
	const launched = out.findIndex((r) => r.type === "tool_execution_update" && /background/.test(JSON.stringify(r.partialResult)));
	assert.ok(launched >= 0 && launched < firstEnd, "launch result shows the card as running, not finished");
	const second = out.slice(t.indexOf("agent_start", t.indexOf("agent_start") + 1));
	assert.ok(second.some((r) => r.type === "message_update" || r.type === "message_end"), "the second turn's text is not dropped");
	assert.equal(t.filter((x) => x === "claude_session").length, 1, "the repeated init is not a second session");
});

test("a repeated init with the same session is no change; a different session id is", () => {
	const tr = createTranslator();
	const init = load("read")[0];
	assert.equal(tr.push(init).length, 1);
	assert.equal(tr.push({ ...init, uuid: "other" }).length, 0);
	const again = tr.push({ ...init, session_id: "another-session" });
	assert.deepEqual(types(again), ["claude_session"]);
	assert.equal(again[0].sessionId, "another-session");
});

test("interrupt then a second prompt: the interrupted turn ends as aborted, the next is a normal turn, no user row for the interrupt marker", () => {
	const out = run("interrupt-continue");
	const t = types(out);
	assert.equal(t.filter((x) => x === "agent_settled").length, 2);
	assert.deepEqual(out.filter((r) => r.type === "agent_settled"), [{ type: "agent_settled", aborted: true }, { type: "agent_settled" }]);
	assert.equal(out.filter((r) => r.type === "message_start" && r.message.role === "user").length, 2, "only our two sends");
	assert.ok(!JSON.stringify(out).includes("Request interrupted"));
	assert.equal(t.filter((x) => x === "claude_session").length, 1);
	assert.ok(!out.some((r) => r.message && r.message.stopReason === "error"));
});
