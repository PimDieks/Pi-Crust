"use strict";
// The watcher logic of the Viewer's live reload (src/viewer-reload.js): real files in a temporary folder, real fs.watch, short waits.
// The end-to-end proof (tabs, pages, the address handler) is the selftest step viewer-reload.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const RL = require("../src/viewer-reload");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-rl-")));
const rm = (d) => fs.rmSync(d, { recursive: true, force: true });
const make = (opts = {}) => {
	const calls = [];
	const w = RL.create({ debounceMs: 80, ...opts, onChange: (id) => calls.push(id) });
	return { w, calls };
};

test("a change to a watched file calls once, after the pause", async () => {
	const dir = tmp();
	const f = path.join(dir, "a.html");
	fs.writeFileSync(f, "1");
	const { w, calls } = make();
	w.add("t1", f);
	fs.writeFileSync(f, "2");
	await sleep(30);
	assert.equal(calls.length, 0, "not before the pause");
	await sleep(400);
	assert.deepEqual(calls, ["t1"]);
	w.dropAll();
	rm(dir);
});

test("many quick saves give one call", async () => {
	const dir = tmp();
	const f = path.join(dir, "a.html");
	fs.writeFileSync(f, "0");
	const { w, calls } = make();
	w.add("t1", f);
	for (let i = 1; i <= 10; i++) { fs.writeFileSync(f, String(i)); await sleep(10); }
	await sleep(500);
	assert.equal(calls.length, 1);
	w.dropAll();
	rm(dir);
});

test("hundreds of other files in the folder reach nobody", async () => {
	const dir = tmp();
	const f = path.join(dir, "a.html");
	fs.writeFileSync(f, "0");
	const { w, calls } = make();
	w.add("t1", f);
	for (let i = 0; i < 300; i++) fs.writeFileSync(path.join(dir, `chunk-${i}.js`), "x");
	await sleep(500);
	assert.equal(calls.length, 0);
	w.dropAll();
	rm(dir);
});

test("a file that is deleted and comes back both call; the watcher survives", async () => {
	const dir = tmp();
	const f = path.join(dir, "a.html");
	fs.writeFileSync(f, "0");
	const { w, calls } = make();
	w.add("t1", f);
	fs.rmSync(f);
	await sleep(400);
	assert.equal(calls.length, 1, "deleted");
	fs.writeFileSync(f, "back");
	await sleep(400);
	assert.equal(calls.length, 2, "back");
	w.dropAll();
	rm(dir);
});

test("a folder that is deleted and comes back is noticed (retry every second)", async () => {
	const dir = tmp();
	const sub = path.join(dir, "sub");
	fs.mkdirSync(sub);
	const f = path.join(sub, "a.html");
	fs.writeFileSync(f, "0");
	const { w, calls } = make();
	w.add("t1", f);
	fs.rmSync(sub, { recursive: true });
	await sleep(400);
	fs.mkdirSync(sub);
	fs.writeFileSync(f, "back");
	await sleep(2600);
	assert.ok(calls.length >= 1);
	assert.equal(w.count(), 1, "watching again");
	w.dropAll();
	assert.equal(w.count(), 0);
	rm(dir);
});

test("watchers are shared by folder and closed with the last user", () => {
	const d1 = tmp();
	const d2 = tmp();
	const a = path.join(d1, "a.html");
	const b = path.join(d1, "b.css");
	const c = path.join(d2, "c.js");
	for (const f of [a, b, c]) fs.writeFileSync(f, "x");
	const { w } = make();
	w.add("t1", a);
	w.add("t1", b);
	w.add("t2", a);
	assert.equal(w.count(), 1, "one folder, one watcher, for two tabs");
	w.add("t2", c);
	assert.equal(w.count(), 2);
	w.drop("t1");
	assert.equal(w.count(), 2, "t2 still uses both");
	w.reset("t2");
	assert.equal(w.count(), 0);
	assert.deepEqual(w.filesOf("t2"), []);
	w.dropAll();
	rm(d1);
	rm(d2);
});

test("a tab is bounded to MAX_FILES files", () => {
	const dir = tmp();
	const { w } = make();
	let ok = 0;
	for (let i = 0; i < RL.MAX_FILES + 10; i++) {
		const f = path.join(dir, `f${i}.js`);
		fs.writeFileSync(f, "x");
		if (w.add("t1", f)) ok++;
	}
	assert.equal(ok, RL.MAX_FILES);
	assert.equal(w.filesOf("t1").length, RL.MAX_FILES);
	w.dropAll();
	rm(dir);
});

test("reset drops a change that was about to fire", async () => {
	const dir = tmp();
	const f = path.join(dir, "a.html");
	fs.writeFileSync(f, "0");
	const { w, calls } = make();
	w.add("t1", f);
	fs.writeFileSync(f, "1");
	await sleep(30);
	w.reset("t1");
	await sleep(400);
	assert.equal(calls.length, 0);
	w.dropAll();
	rm(dir);
});

test("the deliberate breaks do what they say (selftest switches)", async () => {
	const dir = tmp();
	const f = path.join(dir, "a.html");
	fs.writeFileSync(f, "0");
	const leak = make({ breakMode: "reload-leak" });
	leak.w.add("t1", f);
	leak.w.drop("t1");
	assert.equal(leak.w.count(), 1, "reload-leak keeps a watcher open");
	leak.w.dropAll();
	rm(dir);
});

test("pageCandidate: a page's own file is watched only when it is a project file; a link out of the project is never watched (S1)", () => {
	const dir = tmp();
	const root = path.join(dir, "project");
	const outside = path.join(dir, "outside");
	fs.mkdirSync(path.join(root, "docs"), { recursive: true });
	fs.mkdirSync(outside);
	fs.writeFileSync(path.join(root, "docs", "a.html"), "x");
	fs.writeFileSync(path.join(outside, "secret.html"), "x");
	let junction = true;
	try { fs.symlinkSync(outside, path.join(root, "linkdir"), "junction"); } catch { junction = false; }
	const c = (...segs) => RL.pageCandidate(root, segs);
	assert.equal(c("docs", "a.html"), path.join(root, "docs", "a.html"));
	assert.equal(c("docs", "gone.html"), path.join(root, "docs", "gone.html"), "a deleted file is still watched, in its own folder");
	assert.equal(c("later", "deeper", "new.html"), path.join(root, "later", "deeper", "new.html"), "a folder that is not there yet, under the project");
	for (const bad of [[], [".git", "x.html"], ["docs", ".x.html"], ["docs", ".."], ["a:b.html"], ["a\\b.html"], ["a\0.html"]]) assert.equal(c(...bad), null, JSON.stringify(bad));
	if (junction) {
		assert.equal(c("linkdir", "secret.html"), null, "a file reached through a link that leads outside");
		assert.equal(c("linkdir", "gone.html"), null, "a missing file in a folder that leads outside");
		assert.equal(c("linkdir", "sub", "gone.html"), null);
	}
	rm(dir);
});
