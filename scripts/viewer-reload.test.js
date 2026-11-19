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
const tmp = () => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pi-rl-")));
const rm = (d) => fs.rmSync(d, { recursive: true, force: true });
// fs.watch has no "ready" event, and on a cold machine a watcher can miss a write made right after it was created. Wait for the folder's
// watch to be live instead of for time: a probe watcher on the same folder (made after the module's own) must see a write to a file nobody
// uses; then the module's watcher is live too. The wait ends the moment that is seen, and the test fails if it never is.
const ready = async (dir) => {
	const probe = path.join(dir, "ready-probe.tmp");
	let seen = false;
	const pw = fs.watch(dir, { persistent: false }, (_type, name) => { if (name === "ready-probe.tmp") seen = true; });
	try {
		for (let i = 0; i < 200 && !seen; i++) {
			fs.writeFileSync(probe, String(i));
			await sleep(25);
		}
	} finally {
		pw.close();
		fs.rmSync(probe, { force: true });
	}
	assert.ok(seen, "the folder's watcher became ready");
};
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
	await ready(dir);
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
	await ready(dir);
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
	await ready(dir);
	fs.rmSync(f);
	await sleep(400);
	assert.equal(calls.length, 1, "deleted");
	fs.writeFileSync(f, "back");
	await sleep(400);
	assert.equal(calls.length, 2, "back");
	w.dropAll();
	rm(dir);
});

const until = async (fn, ms = 6000) => {
	for (let t = 0; t < ms && !fn(); t += 25) await sleep(25);
	return fn();
};

test("a folder that is deleted and comes back is noticed (retry every second)", async () => {
	const dir = tmp();
	const sub = path.join(dir, "sub");
	fs.mkdirSync(sub);
	const f = path.join(sub, "a.html");
	fs.writeFileSync(f, "0");
	const { w, calls } = make();
	w.add("t1", f);
	await ready(sub);
	fs.rmSync(sub, { recursive: true });
	await sleep(400);
	fs.mkdirSync(sub);
	fs.writeFileSync(f, "back");
	assert.ok(await until(() => calls.length >= 1), "the file that came back with its folder is reported");
	assert.equal(w.count(), 1, "watching again");
	w.dropAll();
	assert.equal(w.count(), 0);
	rm(dir);
});

// The defect: on Windows the watcher of a deleted folder neither errors nor closes, so nothing was retried and later saves reached nobody.
test("after a folder is deleted and made again, the next change in it still reloads once", async () => {
	const dir = tmp();
	const sub = path.join(dir, "dist");
	fs.mkdirSync(sub);
	const f = path.join(sub, "a.html");
	fs.writeFileSync(f, "0");
	const { w, calls } = make();
	w.add("t1", f);
	await ready(sub);
	for (let round = 1; round <= 2; round++) {
		fs.rmSync(sub, { recursive: true });
		fs.mkdirSync(sub);
		fs.writeFileSync(f, "built " + round);
		assert.ok(await until(() => calls.length >= 1), "round " + round + ": the rebuilt file is reported");
		await sleep(400);
		await ready(sub);
		calls.length = 0;
		fs.writeFileSync(f, "edited " + round);
		await sleep(600);
		assert.equal(calls.length, 1, "round " + round + ": one reload follows the next change");
		assert.equal(w.count(), 1, "one watcher");
	}
	w.dropAll();
	rm(dir);
});

test("a folder that is renamed away and back keeps working", async () => {
	const dir = tmp();
	const sub = path.join(dir, "sub");
	const away = path.join(dir, "away");
	fs.mkdirSync(sub);
	const f = path.join(sub, "a.html");
	fs.writeFileSync(f, "0");
	const { w, calls } = make();
	w.add("t1", f);
	await ready(sub);
	fs.renameSync(sub, away);
	await sleep(1500);
	fs.renameSync(away, sub);
	await sleep(1500);
	assert.equal(w.count(), 1);
	await ready(sub);
	calls.length = 0;
	fs.writeFileSync(f, "changed");
	await sleep(600);
	assert.equal(calls.length, 1, "one reload after the folder came back");
	w.dropAll();
	rm(dir);
});

test("a folder replaced by a link that leads elsewhere is not followed", async () => {
	const dir = tmp();
	const sub = path.join(dir, "sub");
	const outside = path.join(dir, "outside");
	fs.mkdirSync(sub);
	fs.mkdirSync(outside);
	const f = path.join(sub, "a.html");
	fs.writeFileSync(f, "0");
	fs.writeFileSync(path.join(outside, "a.html"), "secret");
	const { w, calls } = make();
	w.add("t1", f);
	await ready(sub);
	fs.rmSync(sub, { recursive: true });
	try { fs.symlinkSync(outside, sub, "junction"); } catch { w.dropAll(); rm(dir); return; } // no links here: nothing to check
	await sleep(2500);
	assert.equal(w.count(), 0, "no watcher on the link's target");
	calls.length = 0;
	fs.writeFileSync(path.join(outside, "a.html"), "changed outside");
	await sleep(600);
	assert.equal(calls.length, 0, "a change outside reaches nobody");
	w.dropAll();
	rm(dir);
});

test("no watcher is leaked across many delete and recreate rounds", async () => {
	const dir = tmp();
	const sub = path.join(dir, "sub");
	fs.mkdirSync(sub);
	const f = path.join(sub, "a.html");
	fs.writeFileSync(f, "0");
	const { w } = make();
	w.add("t1", f);
	w.add("t2", f);
	for (let i = 0; i < 6; i++) {
		fs.rmSync(sub, { recursive: true });
		fs.mkdirSync(sub);
		fs.writeFileSync(f, "r" + i);
		assert.ok(await until(() => w.count() === 1 && fs.existsSync(f)), "round " + i);
		await sleep(1100); // let the check of the folder's identity run between rounds
		assert.equal(w.count(), 1, "round " + i + ": exactly one watcher for the folder");
	}
	w.drop("t1");
	assert.equal(w.count(), 1, "t2 still uses it");
	w.drop("t2");
	assert.equal(w.count(), 0, "all closed");
	w.dropAll();
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
	assert.equal(c("docs", "a.html"), path.join(root, "docs", "a.html"), `candidate ${c("docs", "a.html")} vs ${path.join(root, "docs", "a.html")}`);
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
