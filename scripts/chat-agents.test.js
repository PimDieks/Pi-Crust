"use strict";
// Chat agents (phase 7, T8): which agent a chat has, open-chats.json, restore, the merged history list, refusal of an unknown agent.
// No Electron, no real SDK, no key: the Claude adapter runs against the stand-in SDK.
// CHAT_AGENTS_BREAK=<default|mixed|legacy|merge|refuse|pistart|nokey> breaks one group on purpose (the negative control: that group must go red).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");
const { execFileSync } = require("child_process");
const CA = require("../src/chat-agents");
const A = require("../src/agents/adapter");
const { createRegistry } = require("../src/agents/registry");
const { createClaudeAdapter, NO_KEY } = require("../src/agents/claude");

const BREAK = process.env.CHAT_AGENTS_BREAK || "";
const ROOT = path.join(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "chat-agents-"));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const standIn = () => import(pathToFileURL(path.join(__dirname, "claude-sdk-stand-in.mjs")).href);
// main.js as last released (branch main, before T8). Without that branch (a shallow checkout) the two reviewed fragments stand in for it.
const mainOnMain = () => {
	try {
		return execFileSync("git", ["show", "main:src/main.js"], { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 26, stdio: ["ignore", "pipe", "ignore"] });
	} catch {
		return [
			'const files = [...new Set(saved.files || [])].filter((f) => typeof f === "string" && fs.existsSync(f));',
			'openList = files.map((file) => ({ id: newChatId(), file, cwd: typeof saved.cwds?.[file] === "string" ? saved.cwds[file] : null }));',
			"const handle = agent.start({ pi, cwd: cwd || REPO, env: ENV, settings: readSettings(), sessionRef: sessionFile }, sink);",
		].join("\n");
	}
};

// The code under test, optionally broken.
const restore = (saved, exists) => {
	const r = CA.restoreEntries(saved, exists);
	return BREAK === "default" ? r.map((e) => ({ ...e, agent: "claude" })) : r;
};
const serialize = (list, active) => {
	const r = CA.serializeOpenChats(list, active);
	if (BREAK === "mixed") delete r.agents;
	if (BREAK === "legacy") r.files = r.files.map((file) => ({ file }));
	return r;
};
const listAll = async (o) => {
	const r = await CA.listAllSessions(o);
	return BREAK === "merge" && Object.values(r.status).some((s) => !s.ok) ? { ...r, sessions: [] } : r;
};
const resolveAgent = (v, reg) => (BREAK === "refuse" ? CA.agentIdOf(v) : CA.resolveNewChatAgent(v, reg));

const piFile = path.join(tmp, "pi-session.jsonl");
fs.writeFileSync(piFile, "{}\n");
const piFile2 = path.join(tmp, "pi-session2.jsonl");
fs.writeFileSync(piFile2, "{}\n");
const exists = (f) => fs.existsSync(f);

const fakePi = (extra = {}) => ({
	id: "pi",
	label: "Pi",
	capabilities: A.capabilities(),
	strings: { notRunning: "x" },
	locate: () => null,
	pathExtras: () => [],
	start(opts) {
		this.starts.push(opts);
		return {};
	},
	starts: [],
	canSend: () => true,
	state: () => ({ pid: 1, exitCode: null, signalCode: null }),
	onceExit() {},
	killRemains() {},
	send: () => true,
	stop() {},
	listSessions: async () => [],
	auth: null,
	mcpConfigPath: () => null,
	onAppStart() {},
	...extra,
});
const keystore = (key) => ({ read: async () => (key ? { source: "stored", key } : { source: "none", key: null }), status: async () => ({ source: key ? "stored" : "none" }), set: async () => ({ ok: true }), clear: async () => ({ ok: true }) });
async function claudeRig(key = "sk-ant-test-DUMMYKEY-0123456789") {
	const sdk = await standIn();
	sdk.reset();
	const adapter = createClaudeAdapter({ enginePath: () => ({ path: "C:/stub/claude.exe" }), keystore: keystore(key), configDir: path.join(tmp, "cfg"), isPackaged: () => false, loadSdk: async () => sdk, killTree: () => {}, getSettings: () => ({}), env: {} });
	const events = { ready: [], exit: [] };
	const sink = { isCurrent: () => true, ready: (h, d) => events.ready.push(d), record() {}, stderr() {}, exit: (h, i) => events.exit.push(i) };
	const until = async (f) => {
		const t = Date.now();
		while (!f()) {
			if (Date.now() - t > 3000) throw new Error("timed out");
			await new Promise((r) => setTimeout(r, 5));
		}
	};
	return { sdk, adapter, events, sink, until };
}

test("an old open-chats.json entry without agent restores as Pi, as the old reader reads it", () => {
	const saved = { files: [piFile, piFile2], active: piFile, cwds: { [piFile2]: "/wt" } };
	const got = restore(saved, exists);
	assert.deepEqual(got, [
		{ file: piFile, cwd: null, agent: "pi" },
		{ file: piFile2, cwd: "/wt", agent: "pi" },
	]);
	assert.deepEqual(got.map(({ file, cwd }) => ({ file, cwd })), CA.legacyRestoreEntries(saved, exists));
	assert.equal(CA.agentIdOf(undefined), "pi");
	assert.equal(CA.agentIdOf(""), "pi");
});

test("a file with Pi chats only is written exactly as before (no agents field)", () => {
	const list = [{ id: "chat-1", file: piFile, cwd: null, agent: "pi" }, { id: "chat-2", file: piFile2, cwd: "/wt" }];
	assert.deepEqual(serialize(list, "chat-2"), { files: [piFile, piFile2], active: piFile2, cwds: { [piFile2]: "/wt" } });
});

test("a mixed file restores one Pi and one Claude chat, each started by its own adapter; Claude resumes its session id", async () => {
	const t = await claudeRig();
	const pi = fakePi();
	const reg = createRegistry();
	reg.register(pi);
	reg.register(t.adapter);
	const rec = JSON.parse(JSON.stringify(serialize([{ id: "a", file: piFile, cwd: null, agent: "pi" }, { id: "b", file: "sess-abc-123", cwd: null, agent: "claude" }], "b")));
	assert.deepEqual(rec.agents, { "sess-abc-123": "claude" });
	const entries = restore(rec, exists);
	assert.deepEqual(entries.map((e) => e.agent), ["pi", "claude"], "a Claude session id is not a path: it is not dropped for not existing");
	for (const e of entries) reg.get(e.agent).start({ cwd: tmp, sessionRef: e.file, env: {} }, t.sink);
	await t.until(() => t.events.ready.length === 1);
	assert.equal(pi.starts.length, 1);
	assert.equal(pi.starts[0].sessionRef, piFile);
	assert.equal(t.sdk.calls.length, 1);
	assert.equal(t.sdk.calls[0].options.resume, "sess-abc-123");
});

test("a Claude chat that cannot start keeps its tab entry and says why; it is not dropped and not turned into Pi", async () => {
	const t = await claudeRig(null);
	const rec = serialize([{ id: "b", file: "sess-abc-123", cwd: null, agent: "claude" }], "b");
	const entries = restore(rec, exists);
	assert.equal(entries.length, 1);
	assert.equal(entries[0].agent, "claude");
	t.adapter.start({ cwd: tmp, sessionRef: entries[0].file, env: {} }, t.sink);
	await t.until(() => t.events.exit.length === 1);
	assert.equal(t.events.exit[0].kind, "error");
	assert.equal(t.events.exit[0].error, NO_KEY);
	assert.ok(t.events.exit[0].error.length > 10);
	assert.equal(t.sdk.calls.length, 0);
	// What main does with an exit of kind "error" is to send pi:exit and keep the tab; the entry is only removed by an explicit close.
	const main = fs.readFileSync(path.join(ROOT, "src", "main.js"), "utf8");
	assert.ok(/info\.kind === "error"[\s\S]{0,400}send\("pi:exit", \{ chatId, error: info\.error/.test(main));
	if (BREAK === "nokey") assert.equal(restore(rec, () => false).length, 0, "an entry dropped for its missing session file");
});

test("the last released app's reader ignores the new field and still restores what it knows", () => {
	const mixed = JSON.parse(JSON.stringify({ "/repo": serialize([{ id: "a", file: piFile, cwd: "/wt", agent: "pi" }, { id: "b", file: "sess-abc-123", cwd: null, agent: "claude" }], "a") }));
	const saved = mixed["/repo"];
	assert.ok(saved.agents, "the field is there");
	const old = CA.legacyRestoreEntries(saved, exists); // main's reader, copied: only files, active, cwds
	assert.deepEqual(old, [{ file: piFile, cwd: "/wt" }]);
	assert.equal(saved.active, piFile);
	// The copy cannot drift unnoticed from what main really reads.
	const src = mainOnMain();
	assert.ok(src.includes('const files = [...new Set(saved.files || [])].filter((f) => typeof f === "string" && fs.existsSync(f));'));
	assert.ok(src.includes('cwd: typeof saved.cwds?.[file] === "string" ? saved.cwds[file] : null'));
	assert.ok(!/saved\.agents?\b/.test(src), "main's reader does not read agent");
});

test("history: each adapter is asked; one failing gives its own empty list with a reason; sort and cap as Pi's list", async () => {
	const mk = (id, list) => fakePi({ id, label: id, listSessions: typeof list === "function" ? list : async () => list });
	const pi = mk("pi", [{ path: "p1", firstPrompt: "a", mtime: 100 }, { path: "p2", firstPrompt: "b", mtime: 300 }]);
	const claude = mk("claude", [{ path: "c1", firstPrompt: "c", mtime: 200 }]);
	const bad = mk("broken", async () => {
		throw new Error("engine missing");
	});
	let r = await listAll({ adapters: [pi, claude, bad], repo: "/r" });
	assert.deepEqual(r.sessions.map((s) => [s.path, s.agent]), [["p2", "pi"], ["c1", "claude"], ["p1", "pi"]]);
	assert.deepEqual(r.status.broken, { ok: false, count: 0, reason: "engine missing" });
	assert.equal(r.status.pi.ok, true);
	assert.equal(r.status.claude.count, 1);
	const many = (id, n, base) => mk(id, Array.from({ length: n }, (_, i) => ({ path: `${id}${i}`, firstPrompt: "x", mtime: base + i })));
	r = await listAll({ adapters: [many("pi", 50, 0), many("claude", 50, 1000)], repo: "/r" });
	assert.equal(r.sessions.length, 60);
	assert.ok(r.sessions.every((s, i) => i === 0 || r.sessions[i - 1].mtime >= s.mtime));
	// A non-default agent is asked once per folder; worktree entries carry cwd and branch.
	const seen = [];
	const cl = mk("claude", async (o) => (seen.push(o), [{ path: `s-${o.cwd}`, firstPrompt: "x", mtime: 5 }]));
	r = await listAll({ adapters: [cl], repo: "/r", worktrees: [{ cwd: "/wt", branch: "feat" }] });
	assert.deepEqual(seen.map((o) => o.cwd), ["/r", "/wt"]);
	assert.deepEqual(r.sessions.map((s) => [s.cwd ?? null, s.branch ?? null]).sort(), [[null, null], ["/wt", "feat"]]);
});

test("a new chat with an unknown agent id is refused; none means Pi", () => {
	const reg = createRegistry();
	reg.register(fakePi());
	reg.register(fakePi({ id: "claude", label: "Claude Agent" }));
	assert.equal(resolveAgent(undefined, reg), "pi");
	assert.equal(resolveAgent("claude", reg), "claude");
	assert.equal(resolveAgent("gpt", reg), null);
	assert.equal(resolveAgent(42, reg), null);
	assert.equal(resolveAgent({ id: "pi" }, reg), null);
});

test("a Pi chat's start arguments are byte-identical to before; every start goes through the chat's own agent", () => {
	let src = fs.readFileSync(path.join(ROOT, "src", "main.js"), "utf8");
	if (BREAK === "pistart") src = src.replace("sessionRef: sessionFile }", "sessionRef: sessionFile, agent: 1 }");
	const m = mainOnMain().match(/agent\.start\((\{[^\n]*\}), sink\)/);
	assert.ok(m, "main still has the old call");
	assert.ok(src.includes(`isDefaultAgent ? ${m[1]} :`), "the Pi branch passes the same argument object, character for character");
	// startAgent callers (new chat, reopen, restart, restore) pass the chat's agent; none starts with a fixed one.
	const calls = src.match(/startAgent\([^\n]*\)/g);
	for (const re of [/wanted\)/, /entry\.agent[,)]/, /agentId[,)]/, /e\.agent[,)]/]) assert.ok(calls.some((c) => re.test(c)), String(re));
});

test("pending: a fork tab with no session yet and a rewound chat are written and restored where they stood (order, cwd, active), and Pi-only files stay byte-identical", () => {
	const fork = { from: "sess-parent", at: "uuid-08", view: "uuid-08", parent: "sess-parent", title: "Fork of Sky chat" };
	const rewound = { from: "sess-own", at: null, view: "none", parent: null, title: null };
	const list = [
		{ id: "a", file: piFile, cwd: null, agent: "pi" },
		{ id: "b", file: null, cwd: "/wt", agent: "claude", pending: fork }, // a new fork: no session id yet
		{ id: "c", file: "sess-own", cwd: null, agent: "claude", pending: rewound }, // rewound: its old session id must not bring the old chat back
		{ id: "d", file: "sess-other", cwd: null, agent: "claude" },
	];
	const rec = JSON.parse(JSON.stringify(serialize(list, "b")));
	assert.deepEqual(rec.files, [piFile, "sess-other"], "a pending chat is not listed under its file");
	assert.equal(rec.activeAt, 1);
	assert.equal(rec.active, null);
	const back = restore(rec, exists);
	assert.deepEqual(back.map((e) => [e.agent, e.file, e.cwd, e.pending || null]), [["pi", piFile, null, null], ["claude", null, "/wt", fork], ["claude", null, null, rewound], ["claude", "sess-other", null, null]]);
	assert.equal(CA.activeOf(rec, back), back[1]);
	// an active ordinary chat is found by its file, none by default
	assert.equal(CA.activeOf(JSON.parse(JSON.stringify(serialize(list, "d"))), restore(JSON.parse(JSON.stringify(serialize(list, "d"))), exists)).file, "sess-other");
	assert.equal(CA.activeOf({ files: [piFile], active: null }, restore({ files: [piFile] }, exists)), null);
	// Pi only: no pending, no activeAt, as before
	assert.deepEqual(serialize([{ id: "a", file: piFile, cwd: null, agent: "pi" }], "a"), { files: [piFile], active: piFile, cwds: {} });
	// junk is dropped, never thrown on; a Pi chat never carries one
	const junk = { files: [], pending: [null, 5, { i: 0, agent: "claude", pending: "x" }, { i: 0, agent: "pi", pending: fork }, { i: 0, agent: "claude", pending: { view: 3 } }, { i: 0, agent: "claude", cwd: 7, pending: { view: "none", from: null, title: "x".repeat(500) } }] };
	const j = restore(junk, exists);
	assert.equal(j.length, 1);
	assert.equal(j[0].cwd, null);
	assert.equal(j[0].pending.title.length, 200);
	assert.equal(serialize([{ id: "a", file: piFile, cwd: null, agent: "pi", pending: fork }], "a").pending, undefined);
});
