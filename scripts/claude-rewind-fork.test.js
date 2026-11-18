"use strict";
// Claude Agent rewind and fork (phase 7). Real captured streams of the SDK (normalised, scripts/claude-fixtures/rewind.jsonl and fork-*.jsonl) replayed
// through the adapter with the stand-in SDK (scripts/claude-sdk-stand-in.mjs): the uuid per user message and the last assistant uuid per turn,
// kept across a restart; a fork at the end, before the first message and at turn one passes the right options to the SDK; the parent link and the
// "Fork of ..." title; the app's own file snapshots for a Claude Agent chat, including a file made by a shell command; Pi chats unchanged.
// No Electron, no real SDK, no key, no model, nothing of anyone's repo (temporary folders only).
// CLAUDE_RF_UPDATE=1 rewrites the goldens (review the diff). CLAUDE_RF_BREAK=<group> puts one deliberate fault into that group and it must go red:
//   uuid | options | link | snapshot | pi
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { pathToFileURL } = require("url");
const { createClaudeAdapter } = require("../src/agents/claude");
const { createStore } = require("../src/checkpoints-main");
const turnsLib = require("../src/agents/claude/turns");

const BREAK = process.env.CLAUDE_RF_BREAK || "";
const UPDATE = process.env.CLAUDE_RF_UPDATE === "1";
const DIR = path.join(__dirname, "claude-fixtures");
const STAND_IN = path.join(__dirname, "claude-sdk-stand-in.mjs");
const standIn = () => import(pathToFileURL(STAND_IN).href);
const KEY = "sk-ant-test-DUMMYKEY-0123456789";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "claude-rf-"));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const lines = (name) => fs.readFileSync(path.join(DIR, `${name}.jsonl`), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
// What the host supplied and said, read from the capture itself: the echoed user rows (isReplay) in order.
const sentOf = (name) => lines(name).filter((m) => m.type === "user" && m.isReplay).map((m) => ({ uuid: m.uuid, text: m.message.content }));
const lastAssistants = (name) => {
	const out = [];
	for (const m of lines(name)) {
		if (m.type === "user" && m.isReplay) out.push({ uuid: m.uuid, assistantUuid: null });
		else if (m.type === "assistant" && out.length) out[out.length - 1].assistantUuid = m.uuid;
	}
	return out;
};
// Where each later turn starts in a fixture (its command_lifecycle "queued"): the stand-in waits for the next prompt there.
const turnStarts = (name) => lines(name).map((m, i) => (m.type === "command_lifecycle" && m.state === "queued" ? i : -1)).filter((i) => i > 0);
const golden = (name, value) => {
	const f = path.join(DIR, `${name}.golden.json`);
	if (UPDATE) fs.writeFileSync(f, JSON.stringify(value, null, 1) + "\n");
	return JSON.parse(fs.readFileSync(f, "utf8"));
};

const keystore = () => ({ read: async () => ({ source: "stored", key: KEY }), status: async () => ({ source: "stored" }), set: async () => ({ ok: true }), clear: async () => ({ ok: true }) });

// A running chat on the stand-in. uuids: what the adapter hands out for the next messages (the captured ones), then new-1, new-2 ...
async function rig({ uuids = [], configDir = path.join(tmp, `cfg-${fs.readdirSync(tmp).length}`), wrapSdk, fsImpl, sessionRef, fork, cwd } = {}) {
	const sdk = await standIn();
	if (!rig.keep) sdk.reset();
	cwd = cwd || fs.mkdtempSync(path.join(tmp, "proj-"));
	let n = 0;
	const queue = uuids.slice();
	const adapter = createClaudeAdapter({ enginePath: () => ({ path: "C:/stub/claude.exe" }), keystore: keystore(), configDir, ...(fsImpl ? { fs: fsImpl } : {}), isPackaged: () => false, loadSdk: async () => (wrapSdk ? wrapSdk(sdk) : sdk), killTree: () => {}, getSettings: () => ({}), env: {}, uuid: () => queue.shift() || `new-${++n}` });
	const events = { ready: 0, records: [], exit: [] };
	const sink = { isCurrent: () => true, ready: () => events.ready++, record: (h, r) => events.records.push(r), stderr: () => {}, exit: (h, i) => events.exit.push(i) };
	const h = adapter.start({ cwd, sessionRef, fork }, sink);
	const until = async (f, ms = 4000) => {
		const t0 = Date.now();
		while (!f()) {
			if (Date.now() - t0 > ms) throw new Error("timed out");
			await new Promise((r) => setTimeout(r, 5));
		}
	};
	let seq = 0;
	const ask = async (type, extra = {}) => {
		const id = `rf-${++seq}`;
		adapter.send(h, { id, type, ...extra });
		await until(() => events.records.some((r) => r.type === "response" && r.id === id));
		return events.records.find((r) => r.type === "response" && r.id === id);
	};
	const settled = (k) => events.records.filter((r) => r.type === "agent_settled").length >= k;
	await until(() => events.ready >= 1);
	return { sdk, adapter, h, cwd, configDir, events, until, ask, settled, stop: () => adapter.stop(h) };
}
const userRows = (t) => t.events.records.filter((r) => r.type === "message_start" && r.message.role === "user").map((r) => r.message);
async function runTurns(t, fixture, prompts) {
	t.sdk.setFixture(path.join(DIR, `${fixture}.jsonl`), { awaitUser: turnStarts(fixture) });
	for (let i = 0; i < prompts.length; i++) {
		assert.ok(t.adapter.send(t.h, { type: "prompt", message: prompts[i] }));
		await t.until(() => t.settled(i + 1));
	}
}
// Only the options that are set (JSON, and deepEqual, treat a missing key and an undefined one differently).
const optionsOf = (call) => Object.fromEntries(["resume", "forkSession", "resumeSessionAt"].filter((k) => call.options[k] !== undefined).map((k) => [k, call.options[k]]));
// The SDK's own history rows of a captured run (what getSessionMessages returns): the user and assistant messages, in order.
const rowsOf = (name) => lines(name).filter((m) => m.type === "user" || m.type === "assistant").map(({ isReplay, ...m }) => m);

const REWIND = sentOf("rewind");
const FORK = sentOf("fork-original");
const sidOf = (name) => lines(name).find((m) => m.type === "system" && m.subtype === "init").session_id;

// --- 1. uuids -------------------------------------------------------------------------------------------------------------------------

test("uuid: the adapter gives every user message a uuid, remembers the last assistant uuid of each turn, and gets both back after a restart", async () => {
	const dropUuid = (sdk) => ({ ...sdk, query: (q) => sdk.query({ ...q, prompt: (async function* () { for await (const m of q.prompt) yield BREAK === "uuid" ? { ...m, uuid: undefined } : m; })() }) });
	const t = await rig({ uuids: REWIND.map((s) => s.uuid), wrapSdk: dropUuid });
	await runTurns(t, "rewind", REWIND.map((s) => s.text));
	// supplied to the SDK, and on the rows the app shows
	assert.deepEqual(t.sdk.calls[0].sent.map((m) => m.uuid), REWIND.map((s) => s.uuid), "the SDK got the supplied uuids");
	assert.deepEqual(userRows(t).map((m) => m.uuid), REWIND.map((s) => s.uuid), "the rows carry them");
	assert.equal(userRows(t).length, 3, "the echoed user messages (isReplay) do not become rows");
	assert.ok(t.sdk.calls[0].options.extraArgs && "replay-user-messages" in t.sdk.calls[0].options.extraArgs, "the echo is asked for, as in the capture");
	// the turns: golden from the capture (the last assistant row of each turn, not the first)
	const want = golden("rewind.turns", lastAssistants("rewind"));
	assert.deepEqual(t.h.turns.map(({ uuid, assistantUuid }) => ({ uuid, assistantUuid })), want);
	assert.deepEqual(want.map((x) => x.assistantUuid), ["uuid-19", "uuid-35", "uuid-47"]);
	const listed = await t.ask("get_fork_messages");
	assert.deepEqual(listed.data.messages, REWIND.map((s) => ({ entryId: s.uuid, text: s.text })));
	// stored in the app's own folder, one file per session
	const stored = JSON.parse(fs.readFileSync(path.join(t.configDir, "crust-turns", `${sidOf("rewind")}.json`), "utf8"));
	assert.deepEqual(stored.turns.map(({ uuid, assistantUuid }) => ({ uuid, assistantUuid })), want);
	t.stop();
	// restart: a new adapter on the same folder resumes the session and knows the turns
	rig.keep = true;
	const t2 = await rig({ configDir: t.configDir, sessionRef: sidOf("rewind") });
	rig.keep = false;
	assert.deepEqual((await t2.ask("get_fork_messages")).data.messages, REWIND.map((s) => ({ entryId: s.uuid, text: s.text })), "restored from the store");
	assert.deepEqual(t2.h.turns.map(({ uuid, assistantUuid }) => ({ uuid, assistantUuid })), want);
	t2.stop();
	// restore without a store (an older chat): the same list from the SDK's own history
	fs.rmSync(path.join(t.configDir, "crust-turns"), { recursive: true });
	const sdk = await standIn();
	sdk.reset();
	sdk.setSessionMessages({ [sidOf("rewind")]: rowsOf("rewind") });
	rig.keep = true;
	const t3 = await rig({ configDir: t.configDir, sessionRef: sidOf("rewind") });
	rig.keep = false;
	assert.deepEqual((await t3.ask("get_fork_messages")).data.messages, REWIND.map((s) => ({ entryId: s.uuid, text: s.text })), "rebuilt from history");
	assert.deepEqual(t3.h.turns.map(({ uuid, assistantUuid }) => ({ uuid, assistantUuid })), want);
	t3.stop();
});

test("uuid: history rows carry the uuid, and turnsFromRows skips tool results, subagent rows and interrupt notes", () => {
	const { convertMessages } = require("../src/agents/claude/history");
	const msgs = convertMessages(rowsOf("rewind"));
	assert.deepEqual(msgs.filter((m) => m.role === "user").map((m) => m.uuid), REWIND.map((s) => s.uuid));
	const rows = [
		{ type: "user", uuid: "u1", message: { role: "user", content: "hello" }, parent_tool_use_id: null },
		{ type: "assistant", uuid: "a1", message: { content: [{ type: "text", text: "hi" }] }, parent_tool_use_id: null },
		{ type: "assistant", uuid: "sub", message: { content: [] }, parent_tool_use_id: "toolu-1" },
		{ type: "user", uuid: "tr", message: { content: [{ type: "tool_result", tool_use_id: "toolu-1", content: "x" }] }, parent_tool_use_id: null },
		{ type: "user", uuid: "int", message: { content: [{ type: "text", text: "[Request interrupted by user]" }] }, parent_tool_use_id: null },
		{ type: "assistant", uuid: "a2", message: { content: [] }, parent_tool_use_id: null },
	];
	assert.deepEqual(turnsLib.turnsFromRows(rows).map(({ uuid, assistantUuid }) => ({ uuid, assistantUuid })), [{ uuid: "u1", assistantUuid: "a2" }]);
});

// --- 2. fork: the options the SDK is given ---------------------------------------------------------------------------------------------

async function parentChat() {
	const dropAt = (sdk) => ({ ...sdk, query: (q) => sdk.query({ ...q, options: BREAK === "options" ? { ...q.options, resumeSessionAt: undefined } : q.options }) });
	const t = await rig({ uuids: FORK.map((s) => s.uuid), wrapSdk: dropAt });
	await runTurns(t, "fork-original", FORK.map((s) => s.text));
	t.wrapSdk = dropAt;
	return t;
}

test("fork: from the end, at turn one and before the first message pass the right options to the SDK (new tab)", async () => {
	const t = await parentChat();
	const parent = sidOf("fork-original");
	const asst = lastAssistants("fork-original");
	const got = {};
	const fork = async (label, entryId, fixture) => {
		const spec = await t.adapter.forkSpec(t.h, { entryId, title: "Sky chat" });
		assert.ok(spec.ok, `${label}: ${spec.error}`);
		const prev = t.sdk.calls.length;
		rig.keep = true;
		const c = await rig({ configDir: t.configDir, fork: spec.start, cwd: t.cwd, wrapSdk: t.wrapSdk });
		rig.keep = false;
		c.sdk.setFixture(path.join(DIR, `${fixture}.jsonl`));
		assert.ok(c.adapter.send(c.h, { type: "prompt", message: "What were your previous answers?" }));
		await c.until(() => c.settled(1));
		got[label] = { spec: { text: spec.text, from: spec.start.from, at: spec.start.at, view: spec.start.view, keep: spec.start.turns.map((x) => x.uuid), title: spec.start.title }, options: optionsOf(c.sdk.calls[prev]) };
		c.stop();
		return c;
	};
	await fork("end", null, "fork-latest");
	await fork("turn-one", FORK[1].uuid, "fork-turn1"); // before message 2 = after turn 1's answer (capture-fork query 3)
	await fork("first-message", FORK[0].uuid, "fork-latest");
	const want = golden("fork.options", got);
	assert.deepEqual(got, want);
	// the facts behind the golden, stated apart from it
	assert.deepEqual(got.end.options, { resume: parent, forkSession: true }, "end: resume + forkSession only (query 2)");
	assert.deepEqual(got["turn-one"].options, { resume: parent, forkSession: true, resumeSessionAt: asst[0].assistantUuid }, "turn one: also resumeSessionAt = turn 1's last assistant uuid (query 3)");
	assert.deepEqual(got["first-message"].options, {}, "before the first message: a fresh session, nothing to resume");
	assert.equal(got["turn-one"].spec.text, FORK[1].text, "the message the fork was taken before comes back for the message box");
	t.stop();
});

test("fork: in the chat's own tab (rewind) resumes a cut copy, and the old session is shown cut until the next message", async () => {
	const t = await parentChat();
	const parent = sidOf("fork-original");
	t.sdk.setSessionMessages({ [parent]: rowsOf("fork-original") });
	t.sdk.setFixture(path.join(DIR, "fork-turn1.jsonl"));
	const r = await t.ask("fork", { entryId: FORK[1].uuid });
	assert.equal(r.success, true, r.error);
	assert.deepEqual(r.data, { text: FORK[1].text, cancelled: false });
	const q = t.sdk.calls[t.sdk.calls.length - 1];
	assert.deepEqual(optionsOf(q), { resume: parent, forkSession: true, resumeSessionAt: lastAssistants("fork-original")[0].assistantUuid });
	assert.equal(t.sdk.calls[0].closed, true, "the old query is closed");
	assert.equal(t.events.exit.length, 0, "the chat did not 'stop'");
	assert.equal((await t.ask("get_state")).data.sessionFile, null, "no session of its own yet");
	const shown = (await t.ask("get_messages")).data.messages;
	assert.deepEqual(shown.filter((m) => m.role === "user").map((m) => m.uuid), [FORK[0].uuid], "only turn 1 is shown");
	assert.deepEqual((await t.ask("get_fork_messages")).data.messages.map((m) => m.entryId), [FORK[0].uuid]);
	// the next message gives the chat its own session; the cut turns are gone from its list
	assert.ok(t.adapter.send(t.h, { type: "prompt", message: "again" }));
	await t.until(() => t.settled(3));
	const own = (await t.ask("get_state")).data.sessionFile;
	assert.equal(own, sidOf("fork-turn1"));
	assert.notEqual(own, parent);
	assert.deepEqual(t.h.turns.map((x) => x.uuid), [FORK[0].uuid, "new-1"]);
	// before the first message: a fresh session
	t.sdk.setFixture(path.join(DIR, "fork-latest.jsonl"));
	const first = await t.ask("fork", { entryId: FORK[0].uuid });
	assert.equal(first.success, true);
	assert.deepEqual(optionsOf(t.sdk.calls[t.sdk.calls.length - 1]), {});
	assert.deepEqual((await t.ask("get_messages")).data.messages, []);
	// a message that is not in the list, and a turn without a finished answer, are refused with a reason
	const nope = await t.ask("fork", { entryId: "not-a-message" });
	assert.equal(nope.success, false);
	assert.match(nope.error, /not in this chat/);
	assert.equal(turnsLib.plan([{ uuid: "a", text: "x", assistantUuid: null }, { uuid: "b", text: "y", assistantUuid: null }], "b").ok, false);
	t.stop();
});

// --- 3. the parent link and the title --------------------------------------------------------------------------------------------------

test("link: a fork is named 'Fork of <title>', linked to its parent once its own session exists, and the parent is unchanged", async () => {
	const failWrites = (real) => ({ ...real, writeFileSync: (f, ...a) => (BREAK === "link" && /crust-forks/.test(String(f)) ? undefined : real.writeFileSync(f, ...a)) });
	const t = await parentChat();
	const parent = sidOf("fork-original");
	const parentFile = path.join(t.configDir, "crust-turns", `${parent}.json`);
	const before = fs.readFileSync(parentFile, "utf8");
	const spec = await t.adapter.forkSpec(t.h, { entryId: FORK[1].uuid, title: "Sky chat" });
	assert.equal(spec.start.title, "Fork of Sky chat");
	rig.keep = true;
	const c = await rig({ configDir: t.configDir, fork: spec.start, cwd: t.cwd, fsImpl: failWrites(fs) });
	rig.keep = false;
	assert.equal((await c.ask("get_state")).data.sessionName, "Fork of Sky chat", "named before it has a session");
	assert.equal((await c.ask("get_state")).data.sessionFile, null);
	assert.equal(fs.existsSync(path.join(t.configDir, "crust-forks.json")), false, "nothing is linked before the fork has a session of its own");
	// what a Claude Agent chat shows before its first message: the part of the old chat it continues
	c.sdk.setSessionMessages({ [parent]: rowsOf("fork-original") });
	assert.deepEqual((await c.ask("get_messages")).data.messages.filter((m) => m.role === "user").map((m) => m.uuid), [FORK[0].uuid]);
	c.sdk.setFixture(path.join(DIR, "fork-turn1.jsonl"));
	c.adapter.send(c.h, { type: "prompt", message: "What were your previous answers?" });
	await c.until(() => c.settled(1));
	const child = sidOf("fork-turn1");
	const links = JSON.parse(fs.readFileSync(path.join(t.configDir, "crust-forks.json"), "utf8")).forks;
	assert.deepEqual({ parent: links[child].parent, at: links[child].at, title: links[child].title }, { parent, at: lastAssistants("fork-original")[0].assistantUuid, title: "Fork of Sky chat" });
	assert.deepEqual(c.adapter.forkOf(child), { parent, at: "uuid-08", title: "Fork of Sky chat" });
	assert.equal((await c.ask("get_state")).data.sessionFile, child);
	// the history list: the SDK gives all three the same title; the app's own name replaces the fork's
	const row = (id) => ({ sessionId: id, summary: "Sky color reply", customTitle: "Sky color reply", firstPrompt: "Reply with exactly: The sky is blue.", lastModified: 1795012173214, fileSize: 18075, cwd: t.cwd });
	c.sdk.setSessions([row(child), row(parent)]);
	const list = await c.adapter.listSessions({ cwd: t.cwd });
	assert.deepEqual(list.map((s) => [s.path, s.name]), [[child, "Fork of Sky chat"], [parent, "Sky color reply"]]);
	// the fork's own turns are stored (the kept turn keeps its uuid), and a restored fork still knows its name
	assert.deepEqual(JSON.parse(fs.readFileSync(path.join(t.configDir, "crust-turns", `${child}.json`), "utf8")).turns.map((x) => x.uuid), [FORK[0].uuid, "new-1"]);
	rig.keep = true;
	const r = await rig({ configDir: t.configDir, sessionRef: child, cwd: t.cwd });
	rig.keep = false;
	assert.equal((await r.ask("get_state")).data.sessionName, "Fork of Sky chat");
	// the original chat is untouched: same stored turns byte for byte, same list, same session
	assert.equal(fs.readFileSync(parentFile, "utf8"), before);
	assert.deepEqual((await t.ask("get_fork_messages")).data.messages.map((m) => m.entryId), FORK.map((s) => s.uuid));
	assert.equal((await t.ask("get_state")).data.sessionFile, parent);
	assert.equal(t.sdk.calls[0].closed, false, "the original query was not closed");
	c.stop();
	r.stop();
	t.stop();
});

// --- 4. the app's own snapshots for a Claude Agent chat --------------------------------------------------------------------------------

function git(cwd, ...args) {
	return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@localhost", ...args], { cwd, encoding: "utf8" });
}

test("snapshot: a Claude Agent chat's messages are rewound by the app's snapshots (edit, shell-made file, subagent file), found by uuid, undone", async () => {
	const repo = fs.mkdtempSync(path.join(tmp, "repo-"));
	git(repo, "init", "-q");
	git(repo, "config", "core.autocrlf", "false"); // a global autocrlf would turn the LF files into CRLF on restore
	fs.writeFileSync(path.join(repo, "notes.txt"), "base\n");
	git(repo, "add", "-A");
	git(repo, "commit", "-q", "-m", "base");
	const store = createStore({ repo, dataDir: path.join(tmp, "cp-data") });
	const t = await rig({ uuids: FORK.map((s) => s.uuid), cwd: repo });
	t.sdk.setFixture(path.join(DIR, "fork-original.jsonl"), { awaitUser: turnStarts("fork-original") });
	const tagged = [];
	const send = async (i) => {
		// as rewind.js does: the snapshot is taken before the message; the chat has no session id yet for the first one
		const cp = await store.create({ sessionFile: null, text: FORK[i].text });
		assert.ok(t.adapter.send(t.h, { type: "prompt", message: FORK[i].text }));
		await t.until(() => t.settled(i + 1));
		const uuid = userRows(t)[i].uuid;
		if (BREAK !== "snapshot") await store.tag(cp.id, { uuid, sessionFile: sidOf("fork-original") });
		tagged.push({ cp, uuid });
	};
	await send(0);
	fs.appendFileSync(path.join(repo, "notes.txt"), "one\n"); // turn 1's Edit
	await send(1);
	// turn 2 changes: a shell command makes a file (a real child process), a subagent writes another, and notes.txt grows
	execFileSync(process.execPath, ["-e", "require('fs').writeFileSync('made-by-shell.txt','from a shell command\\n')"], { cwd: repo });
	fs.mkdirSync(path.join(repo, "sub"));
	fs.writeFileSync(path.join(repo, "sub", "by-subagent.txt"), "x\n");
	fs.appendFileSync(path.join(repo, "notes.txt"), "two\n");
	const read = (f) => fs.readFileSync(path.join(repo, f), "utf8");
	// rewind to before message 2, found by its uuid
	const found = store.list({ sessionFile: sidOf("fork-original"), uuid: tagged[1].uuid });
	assert.equal(found.length, 1, "the snapshot of message 2 is found by its uuid");
	assert.equal(found[0].id, tagged[1].cp.id);
	const preview = await store.preview(found[0].id);
	assert.deepEqual(preview.files.map((f) => `${f.status} ${f.path}`).sort(), ["D made-by-shell.txt", "D sub/by-subagent.txt", "M notes.txt"]);
	const done = await store.restore(found[0].id);
	assert.equal(done.ok, true, done.error);
	assert.equal(fs.existsSync(path.join(repo, "made-by-shell.txt")), false, "the file the shell command made is gone");
	assert.equal(fs.existsSync(path.join(repo, "sub", "by-subagent.txt")), false);
	assert.equal(read("notes.txt"), "base\none\n", "turn 1's edit is kept");
	// and the conversation goes back to the same message, through the adapter
	t.sdk.setFixture(path.join(DIR, "fork-turn1.jsonl"));
	const back = await t.ask("fork", { entryId: tagged[1].uuid });
	assert.equal(back.success, true, back.error);
	assert.equal(back.data.text, FORK[1].text);
	// before message 1, then undo of that restore
	const first = store.list({ uuid: tagged[0].uuid })[0];
	const r1 = await store.restore(first.id);
	assert.equal(r1.ok, true);
	assert.equal(read("notes.txt"), "base\n");
	const undo = await store.restore(r1.undoId);
	assert.equal(undo.ok, true);
	assert.equal(read("notes.txt"), "base\none\n", "undo brings back what the rewind had");
	// the first message's snapshot was taken before the chat had a session id: tag() gave it the session file too
	assert.equal(store.list({ sessionFile: sidOf("fork-original") }).filter((e) => e.id === first.id).length, 1, "tagged with the session file as well");
	t.stop();
});

// --- 5. Pi chats unchanged -------------------------------------------------------------------------------------------------------------

test("pi: snapshots by session file, no checkpoint for a chat without one, copy for forks and clones, restore: as before", async () => {
	const repo = fs.mkdtempSync(path.join(tmp, "repo-pi-"));
	git(repo, "init", "-q");
	git(repo, "config", "core.autocrlf", "false"); // a global autocrlf would turn the LF files into CRLF on restore
	fs.writeFileSync(path.join(repo, "a.txt"), "1\n");
	git(repo, "add", "-A");
	git(repo, "commit", "-q", "-m", "base");
	const store = createStore({ repo, dataDir: path.join(tmp, "cp-data-pi") });
	const e1 = await store.create({ sessionFile: "pi-session-1.jsonl", text: "first" });
	fs.writeFileSync(path.join(repo, "a.txt"), "2\n");
	const e2 = await store.create({ sessionFile: "pi-session-1.jsonl", text: "second" });
	assert.deepEqual(store.list({ sessionFile: "pi-session-1.jsonl" }).map((e) => e.id), [e1.id, e2.id]);
	assert.deepEqual(store.list({ sessionFile: "other.jsonl" }), []);
	assert.deepEqual(store.list({ sessionFile: null }), [], "no session file, no checkpoints (BREAK=pi flips this expectation)");
	if (BREAK === "pi") assert.notDeepEqual(store.list({ sessionFile: null }), []);
	assert.equal(store.list().length, 2, "undefined means all of them");
	assert.equal(store.list({ sessionFile: "pi-session-1.jsonl" })[0].uuid, undefined, "a Pi checkpoint has no uuid");
	// a fork of a Pi chat gets its own copies up to the message
	await store.copy("pi-session-1.jsonl", "pi-session-2.jsonl", e1.at);
	assert.equal(store.list({ sessionFile: "pi-session-2.jsonl" }).length, 1);
	const r = await store.restore(store.list({ sessionFile: "pi-session-2.jsonl" })[0].id);
	assert.equal(r.ok, true);
	assert.equal(fs.readFileSync(path.join(repo, "a.txt"), "utf8"), "1\n");
	// Pi's own requests are not Claude's: the capabilities, and the requests the Claude adapter serves
	const pi = require("../src/agents/pi");
	assert.ok(pi.capabilities.fork && pi.capabilities.clone && pi.capabilities.conversationRewind, "Pi keeps fork, clone and rewind");
	const claude = require("../src/agents/claude");
	assert.deepEqual([claude.capabilities.conversationRewind, claude.capabilities.fork, claude.capabilities.clone], [true, true, false], "Claude Agent: rewind and fork yes, clone stays off");
	assert.equal(typeof pi.forkSpec, "undefined", "the new-tab fork is the Claude adapter's own");
	const { UNSUPPORTED } = require("../src/agents/claude/requests");
	assert.deepEqual(Object.keys(UNSUPPORTED).filter((k) => /fork|clone/.test(k)), ["clone"], "only clone is still unsupported for Claude Agent");
});

// --- 5. a fork or a rewound chat before its next message survives a restart ----------------------------------------------------------------

const pendingRecords = (t) => t.events.records.filter((r) => r.type === "claude_pending");
// What the app stores for such a chat and hands back to adapter.start as opts.fork: where it stands, never the turns themselves.
test("pending: a new fork says where it stands, and a restart from that record is the same empty fork tab; its first message links and clears it", async () => {
	const t = await parentChat();
	const parent = sidOf("fork-original");
	const spec = await t.adapter.forkSpec(t.h, { entryId: FORK[1].uuid, title: "Sky chat" });
	rig.keep = true;
	const c = await rig({ configDir: t.configDir, fork: spec.start, cwd: t.cwd });
	assert.deepEqual(pendingRecords(c).map((r) => r.pending), [{ from: parent, at: lastAssistants("fork-original")[0].assistantUuid, view: lastAssistants("fork-original")[0].assistantUuid, parent, title: "Fork of Sky chat" }]);
	const saved = JSON.parse(JSON.stringify(pendingRecords(c)[0].pending)); // what open-chats.json holds
	assert.ok(!("turns" in saved));
	c.stop();
	// the app closes and opens again: a new adapter, the stored record only
	const r = await rig({ configDir: t.configDir, fork: saved, cwd: t.cwd });
	rig.keep = false;
	r.sdk.setSessionMessages({ [parent]: rowsOf("fork-original") });
	assert.equal((await r.ask("get_state")).data.sessionName, "Fork of Sky chat");
	assert.equal((await r.ask("get_state")).data.sessionFile, null, "still no session of its own");
	assert.deepEqual((await r.ask("get_messages")).data.messages.filter((m) => m.role === "user").map((m) => m.uuid), [FORK[0].uuid], "shows the same part of the old chat");
	assert.deepEqual((await r.ask("get_fork_messages")).data.messages.map((m) => m.entryId), [FORK[0].uuid], "and knows its turns");
	r.sdk.setFixture(path.join(DIR, "fork-turn1.jsonl"));
	const prev = r.sdk.calls.length;
	r.adapter.send(r.h, { type: "prompt", message: "again" });
	await r.until(() => r.settled(1));
	assert.deepEqual(optionsOf(r.sdk.calls[prev - 1 + 1] || r.sdk.calls[r.sdk.calls.length - 1]), { resume: parent, forkSession: true, resumeSessionAt: lastAssistants("fork-original")[0].assistantUuid });
	assert.equal(pendingRecords(r).at(-1).pending, null, "once it has a session of its own nothing is pending");
	assert.equal(r.adapter.forkOf(sidOf("fork-turn1")).parent, parent);
	r.stop();
	t.stop();
});

test("pending: a rewind in the chat's own tab says so, and a restart from that record shows the chat as rewound, not as it was", async () => {
	const t = await parentChat();
	const parent = sidOf("fork-original");
	t.sdk.setSessionMessages({ [parent]: rowsOf("fork-original") });
	t.sdk.setFixture(path.join(DIR, "fork-turn1.jsonl"));
	assert.equal((await t.ask("fork", { entryId: FORK[1].uuid })).success, true);
	const at = lastAssistants("fork-original")[0].assistantUuid;
	assert.deepEqual(pendingRecords(t).at(-1).pending, { from: parent, at, view: at, parent: null, title: null });
	const saved = JSON.parse(JSON.stringify(pendingRecords(t).at(-1).pending));
	// before the first message of a chat: nothing is kept, a fresh session
	assert.equal((await t.ask("fork", { entryId: FORK[0].uuid })).success, true);
	assert.deepEqual(pendingRecords(t).at(-1).pending, { from: parent, at: null, view: "none", parent: null, title: null });
	t.stop();
	rig.keep = true;
	const r = await rig({ configDir: t.configDir, fork: saved, cwd: t.cwd });
	rig.keep = false;
	r.sdk.setSessionMessages({ [parent]: rowsOf("fork-original") });
	assert.deepEqual((await r.ask("get_messages")).data.messages.filter((m) => m.role === "user").map((m) => m.uuid), [FORK[0].uuid], "rewound: only turn 1 is shown, not both");
	assert.equal((await r.ask("get_state")).data.sessionFile, null);
	r.stop();
});

test("pending: cutTurns keeps the turns up to the answer the cut ends at", () => {
	const T = (u, a) => ({ uuid: u, text: u, at: 0, assistantUuid: a });
	const turns = [T("u1", "a1"), T("u2", "a2"), T("u3", "a3")];
	assert.deepEqual(turnsLib.cutTurns(turns, "a2").map((x) => x.uuid), ["u1", "u2"]);
	assert.deepEqual(turnsLib.cutTurns(turns, "all").map((x) => x.uuid), ["u1", "u2", "u3"]);
	assert.deepEqual(turnsLib.cutTurns(turns, "none"), []);
	assert.deepEqual(turnsLib.cutTurns(turns, "zzz").map((x) => x.uuid), ["u1", "u2", "u3"], "a cut that cannot be found shows everything rather than nothing");
});

test("pending: the whole way main takes it - fork, the record into open-chats.json, the app closes, restore, the same empty fork tab", async () => {
	const CA = require("../src/chat-agents");
	const t = await parentChat();
	const parent = sidOf("fork-original");
	const spec = await t.adapter.forkSpec(t.h, { entryId: null, title: "Sky chat" }); // a fork from the end
	rig.keep = true;
	const c = await rig({ configDir: t.configDir, fork: spec.start, cwd: t.cwd });
	// main's side: the tab list as it holds the tabs, the fork's record applied, written, read back
	const open = [{ id: "chat-1", file: parent, cwd: null, agent: "claude" }, { id: "chat-2", file: null, cwd: null, agent: "claude", pending: CA.cleanPending(pendingRecords(c).at(-1).pending) }];
	const onDisk = JSON.parse(JSON.stringify({ "/repo": CA.serializeOpenChats(open, "chat-2") }));
	c.stop();
	const saved = onDisk["/repo"];
	const entries = CA.restoreEntries(saved, () => true);
	assert.deepEqual(entries.map((e) => [e.file, !!e.pending]), [[parent, false], [null, true]]);
	assert.equal(CA.activeOf(saved, entries), entries[1], "the empty fork tab was the active one");
	const r = await rig({ configDir: t.configDir, fork: entries[1].pending, cwd: t.cwd });
	rig.keep = false;
	r.sdk.setSessionMessages({ [parent]: rowsOf("fork-original") });
	assert.equal((await r.ask("get_state")).data.sessionName, "Fork of Sky chat");
	assert.deepEqual((await r.ask("get_messages")).data.messages.filter((m) => m.role === "user").map((m) => m.uuid), FORK.map((x) => x.uuid), "a fork from the end shows the whole old chat");
	r.stop();
	t.stop();
});
