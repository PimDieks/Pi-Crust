// Tests for the CI modes of scripts/check-secrets.js (--file, --stdin, --dir, --require-denylist) and scripts/ci-denylist.js.
// The test word is made up. Nothing here uses a real deny-list.
"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SCAN = path.join(__dirname, "check-secrets.js");
const CI = path.join(__dirname, "ci-denylist.js");
const WORD = "zebrafruit";
let tmp;
let list;
const run = (script, args, opts = {}) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8", cwd: path.join(__dirname, ".."), ...opts });
const all = (r) => r.stdout + r.stderr;

before(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ci-scan-"));
	list = path.join(tmp, "list.txt");
	fs.writeFileSync(list, `# comment\n${WORD}\n`);
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test("--file: hit exits 1, names the rule and never prints the word", () => {
	const f = path.join(tmp, "notes.md");
	fs.writeFileSync(f, `hello\nthis mentions ${WORD.toUpperCase()} here\n`);
	const r = run(SCAN, ["--file", f, "--denylist", list]);
	assert.strictEqual(r.status, 1);
	assert.match(all(r), /deny-list rule #1/);
	assert.ok(!all(r).toLowerCase().includes(WORD));
});
test("--file: clean file exits 0 and says how many files were scanned", () => {
	const f = path.join(tmp, "clean.md");
	fs.writeFileSync(f, "nothing to see\n");
	const r = run(SCAN, ["--file", f, "--denylist", list]);
	assert.strictEqual(r.status, 0);
	assert.match(all(r), /Scanned 1 file/);
});
test("--stdin: hit and clean", () => {
	assert.strictEqual(run(SCAN, ["--stdin", "--denylist", list], { input: `x ${WORD} y` }).status, 1);
	assert.strictEqual(run(SCAN, ["--stdin", "--denylist", list], { input: "fine" }).status, 0);
	assert.strictEqual(run(SCAN, ["--stdin", "--denylist", list], { input: "" }).status, 0);
});
test("--dir: finds the word in a file name, in text, in a binary and in UTF-16", () => {
	for (const [name, content] of [
		[`${WORD}.txt`, "clean"],
		["a.txt", `x ${WORD}`],
		["b.bin", Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(WORD), Buffer.from([0])])],
		["c.bin", Buffer.concat([Buffer.from([0, 1]), Buffer.from(WORD, "utf16le")])],
	]) {
		const d = fs.mkdtempSync(path.join(tmp, "d-"));
		fs.mkdirSync(path.join(d, "sub"));
		fs.writeFileSync(path.join(d, "sub", name), content);
		const r = run(SCAN, ["--dir", d, "--denylist", list]);
		assert.strictEqual(r.status, 1, name);
		assert.ok(!all(r).toLowerCase().includes(WORD), `word printed for ${name}`);
	}
});
test("--dir: clean folder passes, empty folder fails (zero files scanned)", () => {
	const d = fs.mkdtempSync(path.join(tmp, "d-"));
	fs.writeFileSync(path.join(d, "ok.txt"), "fine");
	const ok = run(SCAN, ["--dir", d, "--denylist", list]);
	assert.strictEqual(ok.status, 0);
	assert.match(all(ok), /Scanned 1 file/);
	const empty = fs.mkdtempSync(path.join(tmp, "e-"));
	const r = run(SCAN, ["--dir", empty, "--denylist", list]);
	assert.strictEqual(r.status, 1);
	assert.match(all(r), /Nothing was scanned/);
});
test("--dir: missing folder is an error", () => {
	assert.notStrictEqual(run(SCAN, ["--dir", path.join(tmp, "nope"), "--denylist", list]).status, 0);
});
test("--require-denylist: no list or an empty list fails", () => {
	const empty = path.join(tmp, "empty.txt");
	fs.writeFileSync(empty, "# only a comment\n\n");
	const f = path.join(tmp, "x.txt");
	fs.writeFileSync(f, "fine");
	assert.strictEqual(run(SCAN, ["--file", f, "--require-denylist", "--root", tmp]).status, 1);
	const r = run(SCAN, ["--file", f, "--require-denylist", "--denylist", empty]);
	assert.strictEqual(r.status, 1);
	assert.match(all(r), /empty/);
	assert.strictEqual(run(SCAN, ["--file", f, "--require-denylist", "--denylist", list]).status, 0);
});
test("ci-denylist: writes the secret to RUNNER_TEMP, fails when empty, deletes", () => {
	const env = { ...process.env, RUNNER_TEMP: tmp, LEAK_DENYLIST: `${WORD}\nother\n` };
	const w = run(CI, ["write"], { env });
	assert.strictEqual(w.status, 0);
	const file = w.stdout.trim();
	assert.strictEqual(path.dirname(file), tmp);
	assert.ok(!all(w).includes(WORD));
	assert.ok(fs.existsSync(file));
	assert.strictEqual(run(CI, ["delete"], { env }).status, 0);
	assert.ok(!fs.existsSync(file));
	for (const v of ["", "  \n# c\n"]) {
		const r = run(CI, ["write"], { env: { ...env, LEAK_DENYLIST: v } });
		assert.strictEqual(r.status, 1);
		assert.match(all(r), /deny-list missing/);
	}
});
test("--dir --skip: skipped content is not scanned (prefix and *.ext), names still are", () => {
	const d = fs.mkdtempSync(path.join(tmp, "s-"));
	fs.mkdirSync(path.join(d, "vendor"));
	fs.writeFileSync(path.join(d, "vendor", "a.txt"), `x ${WORD}`);
	fs.writeFileSync(path.join(d, "b.PNG"), Buffer.concat([Buffer.from([0]), Buffer.from(WORD)]));
	fs.writeFileSync(path.join(d, "own.txt"), "fine");
	assert.strictEqual(run(SCAN, ["--dir", d, "--denylist", list]).status, 1);
	const ok = run(SCAN, ["--dir", d, "--denylist", list, "--skip", "vendor", "--skip", "*.png"]);
	assert.strictEqual(ok.status, 0);
	assert.match(all(ok), /Scanned 1 file, skipped 2 under --skip/);
	fs.writeFileSync(path.join(d, "vendor", `${WORD}.txt`), "clean");
	assert.strictEqual(run(SCAN, ["--dir", d, "--denylist", list, "--skip", "vendor", "--skip", "*.png"]).status, 1);
});
test("--dir: short random bytes inside a binary do not match, a real string does", () => {
	const d = fs.mkdtempSync(path.join(tmp, "r-"));
	// the word split by non-printable bytes is not a 6+ character printable run on its own, so it is ignored
	fs.writeFileSync(path.join(d, "noise.bin"), Buffer.concat([Buffer.from([0, 1]), Buffer.from("zebra"), Buffer.from([2, 0]), Buffer.from("fruit"), Buffer.from([0])]));
	assert.strictEqual(run(SCAN, ["--dir", d, "--denylist", list]).status, 0);
});
