"use strict";
// A rewound or forked Claude Agent chat that sends its first message: the tab list changes in ONE write (new session AND no pending record).
const test = require("node:test");
const assert = require("node:assert/strict");
const { createEntryWriter } = require("../src/open-chat-entry");
const { cleanPending } = require("../src/chat-agents");

function rig() {
	const list = [{ id: "c1", file: "old-session", agent: "claude", pending: { from: "old-session", at: "m3", view: "v" } }];
	const saves = [];
	const w = createEntryWriter({ find: (id) => list.find((x) => x.id === id), save: () => saves.push(JSON.parse(JSON.stringify(list[0]))), cleanPending });
	return { list, saves, w };
}
test("pending cleared and new session arrive together: one save, with both changes in it", async () => {
	const { saves, w } = rig();
	w.chatPendingRecord("c1", null);
	w.chatSessionRecord("c1", "new-session");
	await Promise.resolve();
	await new Promise((r) => setImmediate(r));
	assert.equal(saves.length, 1, "one write");
	assert.equal(saves[0].file, "new-session");
	assert.ok(!saves[0].pending, "no pending record in that write");
});
test("no save ever shows the new session with the old pending record, or no pending record with the old session", async () => {
	const { saves, w } = rig();
	w.chatPendingRecord("c1", null);
	w.chatSessionRecord("c1", "new-session");
	await new Promise((r) => setImmediate(r));
	for (const s of saves) assert.ok((s.file === "new-session") === !s.pending, JSON.stringify(s));
});
test("a pending clear that no session follows is still saved (after the turn of the loop)", async () => {
	const { saves, w, list } = rig();
	w.chatPendingRecord("c1", null);
	assert.equal(saves.length, 0);
	await new Promise((r) => setImmediate(r));
	assert.equal(saves.length, 1);
	assert.equal(list[0].file, "old-session");
	assert.equal(list[0].pending, null);
});
test("a plain session id (no pending record) and a new pending record save as before; unknown chats and unchanged values save nothing", () => {
	const { saves, w } = rig();
	w.chatSessionRecord("c1", "s2");
	assert.equal(saves.length, 1);
	w.chatSessionRecord("c1", "s2");
	w.chatSessionRecord("nope", "s3");
	assert.equal(saves.length, 1);
	w.chatPendingRecord("c1", { from: "s2", at: "m1", view: "v" });
	assert.equal(saves.length, 2);
	assert.equal(saves[1].pending.from, "s2");
});
