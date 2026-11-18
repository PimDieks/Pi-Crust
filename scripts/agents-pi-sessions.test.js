"use strict";
// Pi's session reader (src/agents/pi/sessions.js, moved out of main.js in phase 6): fixture folders, nothing real is read.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const S = require("../src/agents/pi/sessions");

const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sessions-"));
const repo = path.join(home, "work", "my-repo");
const wt = path.join(home, "work", "my-repo-wt");
const line = (o) => JSON.stringify(o);
const user = (content) => line({ type: "message", message: { role: "user", content } });
const put = (cwd, name, text, mtimeSec) => {
	const dir = S.sessionsDirFor(cwd, home);
	fs.mkdirSync(dir, { recursive: true });
	const f = path.join(dir, name);
	fs.writeFileSync(f, text);
	fs.utimesSync(f, mtimeSec, mtimeSec);
	return f;
};

test("sessionsDirFor: Pi's folder name, also for drive-letter and POSIX paths; home is a parameter", () => {
	assert.strictEqual(S.sessionsDirFor("C:\\Users\\a\\repo", "/h"), path.join("/h", ".pi", "agent", "sessions", "--C--Users-a-repo--"));
	assert.strictEqual(S.sessionsDirFor("/home/a/repo", "/h"), path.join("/h", ".pi", "agent", "sessions", "--home-a-repo--"));
});

test("sessionSummary: name from session_info, first user prompt (string or text parts), CRLF files, stops at the prompt", async () => {
	const a = put(repo, "a.jsonl", [line({ type: "session_info", name: "Named" }), user("hello there"), user("second")].join("\n") + "\n", 1000);
	const b = put(repo, "b.jsonl", [line({ type: "session", id: 1 }), user([{ type: "text", text: "part one" }, { type: "image" }, { type: "text", text: "part two" }])].join("\r\n") + "\r\n", 1001);
	const c = put(repo, "c.jsonl", [user("x".repeat(500))].join("\n") + "\n", 1002);
	const d = put(repo, "d.jsonl", [line({ type: "message", message: { role: "assistant", content: "hi" } })].join("\n") + "\n", 1003);
	assert.deepStrictEqual(await S.sessionSummary(a), { path: a, name: "Named", firstPrompt: "hello there", messages: 0 });
	assert.deepStrictEqual(await S.sessionSummary(b), { path: b, name: null, firstPrompt: "part one part two", messages: 0 });
	assert.strictEqual((await S.sessionSummary(c)).firstPrompt.length, 200);
	assert.strictEqual((await S.sessionSummary(d)).firstPrompt, null);
	assert.deepStrictEqual(await S.sessionSummary(path.join(home, "missing.jsonl")), { path: path.join(home, "missing.jsonl"), name: null, firstPrompt: null, messages: 0 });
});

test("sessionSummary: a huge first line does not hide the prompt; past 4 MB without a prompt it gives up", async () => {
	const big = line({ type: "message", message: { role: "system", content: "s".repeat(1_500_000) } });
	const ok = put(repo, "big-ok.jsonl", [big, user("after the big one")].join("\n") + "\n", 1100);
	assert.strictEqual((await S.sessionSummary(ok)).firstPrompt, "after the big one");
	const lines = Array.from({ length: 5 }, () => big);
	const late = put(repo, "big-late.jsonl", [...lines, user("too late")].join("\n") + "\n", 1101);
	assert.strictEqual((await S.sessionSummary(late)).firstPrompt, null);
});

test("listSessions: newest first, worktrees marked with cwd and branch, sessions without a prompt dropped, 60 at most", async () => {
	const h2 = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sessions-list-"));
	const mk = (cwd, name, text, t) => {
		const dir = S.sessionsDirFor(cwd, h2);
		fs.mkdirSync(dir, { recursive: true });
		const f = path.join(dir, name);
		fs.writeFileSync(f, text);
		fs.utimesSync(f, t, t);
		return f;
	};
	mk(repo, "old.jsonl", user("old one") + "\n", 2000);
	mk(repo, "empty.jsonl", line({ type: "session" }) + "\n", 2500);
	mk(repo, "not-a-session.txt", user("ignored") + "\n", 2600);
	mk(wt, "wt.jsonl", user("in the worktree") + "\n", 3000);
	const list = await S.listSessions({ repo, worktrees: [{ cwd: wt, branch: "feat" }], home: h2 });
	assert.deepStrictEqual(list.map((s) => [path.basename(s.path), s.firstPrompt, s.cwd, s.branch]), [["wt.jsonl", "in the worktree", wt, "feat"], ["old.jsonl", "old one", null, null]]);
	assert.ok(list.every((s) => typeof s.mtime === "number" && s.size > 0));
	assert.deepStrictEqual(await S.listSessions({ repo: path.join(h2, "nowhere"), home: h2 }), []);
	for (let i = 0; i < 70; i++) mk(repo, `many-${String(i).padStart(2, "0")}.jsonl`, user(`n${i}`) + "\n", 5000 + i);
	const many = await S.listSessions({ repo, home: h2 });
	assert.strictEqual(many.length, 60);
	assert.strictEqual(many[0].firstPrompt, "n69");
});
