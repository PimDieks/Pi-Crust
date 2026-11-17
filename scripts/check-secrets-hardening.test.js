// Tests for: invalid deny-list rules (never print the rule), scan-unpacked (own code is scanned in full, missing src fails),
// and `git grep` failures failing the --all scan. All words are made up; nothing here uses a real deny-list.
"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SCAN = path.join(__dirname, "check-secrets.js");
const CI = path.join(__dirname, "ci-denylist.js");
const UNPACKED = path.join(__dirname, "scan-unpacked.js");
const WORD = "quuxberry";
let tmp;
let list;
const run = (script, args, opts = {}) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8", cwd: path.join(__dirname, ".."), ...opts });
const all = (r) => r.stdout + r.stderr;
const write = (file, content) => (fs.mkdirSync(path.dirname(file), { recursive: true }), fs.writeFileSync(file, content));

before(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hard-scan-"));
	list = path.join(tmp, "list.txt");
	fs.writeFileSync(list, `${WORD}\n`);
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test("invalid deny-list rule: exits non-zero, names the rule number, never prints the rule text", () => {
	const bad = path.join(tmp, "bad.txt");
	fs.writeFileSync(bad, `fine\n${WORD}(\n`);
	const f = path.join(tmp, "x.txt");
	fs.writeFileSync(f, "nothing");
	for (const args of [["--file", f], ["--dir", tmp], ["--all"], ["--history"], ["--staged"]]) {
		const r = run(SCAN, [...args, "--denylist", bad]);
		assert.notStrictEqual(r.status, 0, args.join(" "));
		assert.match(all(r), /deny-list rule #2 is invalid/);
		assert.ok(!all(r).toLowerCase().includes(WORD), `rule text printed for ${args[0]}`);
	}
});
test("ci-denylist write: an invalid rule fails, writes nothing, never prints the rule text", () => {
	const env = { ...process.env, RUNNER_TEMP: tmp, LEAK_DENYLIST: `ok\n${WORD}(\n` };
	fs.rmSync(path.join(tmp, "leak-denylist.txt"), { force: true });
	const r = run(CI, ["write"], { env });
	assert.notStrictEqual(r.status, 0);
	assert.match(all(r), /deny-list rule #2 is invalid/);
	assert.ok(!all(r).toLowerCase().includes(WORD));
	assert.ok(!fs.existsSync(path.join(tmp, "leak-denylist.txt")));
});

function unpacked(name, jsCount = 45) {
	const d = path.join(tmp, name);
	for (let i = 0; i < jsCount; i++) write(path.join(d, "resources/app/src", `m${i}.js`), "// fine\n");
	write(path.join(d, "resources/app/package.json"), "{}");
	return d;
}
test("scan-unpacked: a planted word in resources/app/src/x.dat is found, and the word is not printed", () => {
	const d = unpacked("u1");
	write(path.join(d, "resources/app/src/x.dat"), Buffer.concat([Buffer.from([0, 1]), Buffer.from(`pre ${WORD} post`), Buffer.from([0])]));
	const r = run(UNPACKED, [d, list]);
	assert.strictEqual(r.status, 1);
	assert.match(all(r), /deny-list rule #1/);
	assert.ok(!all(r).toLowerCase().includes(WORD));
});
test("scan-unpacked: a top-level app file with a skipped extension is scanned too; the same file elsewhere is still skipped", () => {
	const d = unpacked("u2");
	write(path.join(d, "resources/app/icon.png"), Buffer.concat([Buffer.from([0]), Buffer.from(WORD), Buffer.from([0])]));
	assert.strictEqual(run(UNPACKED, [d, list]).status, 1);
	fs.rmSync(path.join(d, "resources/app/icon.png"));
	write(path.join(d, "vendor.dat"), Buffer.concat([Buffer.from([0]), Buffer.from(WORD), Buffer.from([0])]));
	const ok = run(UNPACKED, [d, list]);
	assert.strictEqual(ok.status, 0, all(ok));
});
test("scan-unpacked: a clean folder passes and prints the counts", () => {
	const r = run(UNPACKED, [unpacked("u3"), list]);
	assert.strictEqual(r.status, 0, all(r));
	assert.match(all(r), /Own code: 45 \.js files under resources\/app\/src, 1 top-level files/);
});
test("scan-unpacked: missing resources/app/src fails", () => {
	const d = path.join(tmp, "u4");
	write(path.join(d, "resources/app/package.json"), "{}");
	const r = run(UNPACKED, [d, list]);
	assert.strictEqual(r.status, 1);
	assert.match(all(r), /resources\/app\/src is missing/);
});
test("scan-unpacked: too few .js files fails and prints the count", () => {
	const r = run(UNPACKED, [unpacked("u5", 3), list]);
	assert.strictEqual(r.status, 1);
	assert.match(all(r), /only 3 \.js files/);
});

function repo(name, files) {
	const d = path.join(tmp, name);
	fs.mkdirSync(d, { recursive: true });
	const g = (...a) => spawnSync("git", ["-C", d, ...a], { encoding: "utf8" });
	g("init", "-q");
	for (const [f, c] of Object.entries(files)) write(path.join(d, f), c);
	g("add", ".");
	g("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "x");
	return d;
}
test("--all: git grep exit status 1 (no match anywhere) is fine, any other git grep failure fails the scan", () => {
	const d = repo("r1", { "empty.txt": "" });
	const ok = run(SCAN, ["--all", "--root", d, "--denylist", list]);
	assert.strictEqual(ok.status, 0, all(ok));
	const env = { ...process.env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "grep.threads", GIT_CONFIG_VALUE_0: "notanumber" };
	const bad = run(SCAN, ["--all", "--root", d, "--denylist", list], { env });
	assert.strictEqual(bad.status, 1);
	assert.match(all(bad), /git grep failed/);
});
test("--all: finds a word in a file whose name has a space and whose text has colons", () => {
	const d = repo("r2", { "a b.txt": `1:2:${WORD}\n` });
	const r = run(SCAN, ["--all", "--root", d, "--denylist", list]);
	assert.strictEqual(r.status, 1);
	assert.match(all(r), /a b\.txt:1 {2}deny-list rule #1/);
});
test("scan-unpacked --no-denylist: built-in secret patterns still run without a word list", () => {
	const d = unpacked("u6");
	assert.strictEqual(run(UNPACKED, [d, "--no-denylist"]).status, 0);
	write(path.join(d, "resources/app/src/k.js"), `const k = "${["gh", "p_"].join("")}${"a1B2".repeat(9)}";\n`);
	assert.strictEqual(run(UNPACKED, [d, "--no-denylist"]).status, 1);
});
