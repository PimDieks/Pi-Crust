"use strict";
// The approval prompt of Claude Agent chats in the main process (src/claude-approval-main.js): the request goes to the renderer as the same
// extension_ui_request a Pi chat's permission extension sends; anything but a clear answer is a deny. No Electron, no SDK.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createApprovals } = require("../src/claude-approval-main");

const PROMPT = { title: "Allow this command?\nnpm run build\nMode: Ask before commands", options: ["Allow once", "Allow for this chat", "Deny"], risky: false };
function rig({ window = true, current = true, timeoutMs } = {}) {
	const sent = [];
	const state = { window, current };
	const a = createApprovals({ send: (c, p) => sent.push([c, p]), hasWindow: () => state.window, isCurrent: () => state.current, timeoutMs });
	const reqs = () => sent.filter(([c]) => c === "pi:record").map(([, p]) => p);
	const resolved = () => sent.filter(([c]) => c === "pi:uiResolved").map(([, p]) => p);
	return { a, sent, reqs, resolved, state };
}
const H = { pid: 1 };

test("the prompt goes out as an extension_ui_request select with the gate's own options and no Cancel; the chosen option comes back", async () => {
	const t = rig();
	const p = t.a.ask("c1", H, PROMPT, {});
	const [r] = t.reqs();
	assert.equal(r.chatId, "c1");
	assert.equal(r.record.type, "extension_ui_request");
	assert.equal(r.record.method, "select");
	assert.equal(r.record.title, PROMPT.title);
	assert.deepEqual(r.record.options, ["Allow once", "Allow for this chat", "Deny"]);
	assert.equal(typeof r.record.id, "string");
	assert.equal(t.a.owns({ id: r.record.id }), true);
	assert.equal(t.a.answer("c1", { type: "extension_ui_response", id: r.record.id, value: "Allow for this chat" }), true);
	assert.equal(await p, "Allow for this chat");
	assert.equal(t.a.size(), 0);
	assert.equal(t.a.answer("c1", { id: r.record.id, value: "Allow once" }), false, "one answer only");
});

test("Cancel, no value, a wrong chat id or an unknown id are not an answer; a risky prompt keeps its two options", async () => {
	for (const resp of [{ cancelled: true }, {}, { value: 5 }, { value: "Allow once", cancelled: true }]) {
		const t = rig();
		const p = t.a.ask("c1", H, PROMPT, {});
		const id = t.reqs()[0].record.id;
		assert.equal(t.a.answer("c2", { id, value: "Allow once" }), false, "another chat cannot answer");
		assert.equal(t.a.answer("c1", { id: "nope", value: "Allow once" }), false);
		assert.equal(t.a.size(), 1);
		t.a.answer("c1", { id, ...resp });
		assert.equal(await p, undefined, JSON.stringify(resp));
	}
	const t = rig();
	t.a.ask("c1", H, { title: "t", options: ["Allow once", "Deny"], risky: true }, {});
	assert.deepEqual(t.reqs()[0].record.options, ["Allow once", "Deny"]);
});

test("a closed or replaced chat, a destroyed window, an aborted call and a timeout all answer deny, and the prompt leaves the screen", async () => {
	// closed
	let t = rig();
	let p = t.a.ask("c1", H, PROMPT, {});
	t.a.closeChat("c1");
	assert.equal(await p, undefined);
	assert.deepEqual(t.resolved().map((x) => x.by), ["closed"]);
	// an old process ending does not close the prompt of its replacement
	t = rig();
	const NEW = { pid: 2 };
	p = t.a.ask("c1", NEW, PROMPT, {});
	t.a.closeChat("c1", H);
	assert.equal(t.a.size(), 1);
	t.a.closeChat("c1", NEW);
	assert.equal(await p, undefined);
	// the window goes away
	t = rig();
	p = t.a.ask("c1", H, PROMPT, {});
	t.a.closeAll();
	assert.equal(await p, undefined);
	t.state.window = false;
	assert.equal(await t.a.ask("c1", H, PROMPT, {}), undefined, "no window: no prompt, deny");
	assert.equal(t.reqs().length, 1);
	// the chat is no longer current
	t = rig({ current: false });
	assert.equal(await t.a.ask("c1", H, PROMPT, {}), undefined);
	assert.equal(t.reqs().length, 0);
	// aborted: before and while it waits
	t = rig();
	const done = new AbortController();
	done.abort();
	assert.equal(await t.a.ask("c1", H, PROMPT, { signal: done.signal }), undefined);
	assert.equal(t.reqs().length, 0);
	const live = new AbortController();
	p = t.a.ask("c1", H, PROMPT, { signal: live.signal });
	live.abort();
	assert.equal(await p, undefined);
	assert.deepEqual(t.resolved().map((x) => x.by), ["cancelled"]);
	// timeout
	t = rig({ timeoutMs: 30 });
	assert.equal(await t.a.ask("c1", H, PROMPT, {}), undefined);
	assert.deepEqual(t.resolved().map((x) => x.by), ["timeout"]);
	assert.equal(t.a.size(), 0);
	// a prompt that is not one
	for (const bad of [null, {}, { title: "t" }, { title: 1, options: [] }, { title: "t", options: "x" }]) assert.equal(await rig().a.ask("c1", H, bad, {}), undefined);
});
