// Regression tests for scripts/move-to-public.js. Everything runs on throwaway repos and `git clone --no-hardlinks`
// copies in a temp folder (set MOVE_TEST_TMP to choose where); no real clone is touched.
"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SCRIPT = path.join(__dirname, "move-to-public.js");
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
let base;
let pubDir;
let privDir;
let n = 0;

const git = (cwd, ...args) => {
	const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: GIT_ENV });
	assert.strictEqual(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
	return r.stdout.trim();
};
const write = (dir, rel, text) => {
	fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
	fs.writeFileSync(path.join(dir, rel), text);
};
const run = (args) => {
	const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env: GIT_ENV });
	return { code: r.status, out: r.stdout, err: r.stderr };
};
// A fresh clone of the "old private" repo, in its own folder so the bundle lands beside it.
const newClone = () => {
	const holder = path.join(base, `case${++n}`);
	fs.mkdirSync(holder);
	const dir = path.join(holder, "clone");
	const r = spawnSync("git", ["clone", "--no-hardlinks", "-q", privDir, dir], { encoding: "utf8", env: GIT_ENV });
	assert.strictEqual(r.status, 0, r.stderr);
	return { holder, dir };
};
const move = (dir, extra = []) => run(["--root", dir, "--public-url", pubDir, "--no-install", ...extra]);

before(() => {
	base = fs.mkdtempSync(path.join(process.env.MOVE_TEST_TMP || os.tmpdir(), "move-to-public-"));
	privDir = path.join(base, "priv");
	pubDir = path.join(base, "pub");
	for (const d of [privDir, pubDir]) {
		fs.mkdirSync(d);
		git(d, "init", "-q", "-b", "main");
	}
	write(privDir, ".gitignore", ".env\nsrc/local/\n");
	write(privDir, "app.txt", "private app\n");
	git(privDir, "add", "-A");
	git(privDir, "commit", "-q", "-m", "private");
	write(pubDir, ".env", "PUBLIC=1\n");
	write(pubDir, "app.txt", "public app\n");
	git(pubDir, "add", "-A");
	git(pubDir, "commit", "-q", "-m", "public");
});

after(() => fs.rmSync(base, { recursive: true, force: true }));

test("refuses when an ignored local file would be overwritten, and leaves it untouched", () => {
	const { holder, dir } = newClone();
	write(dir, ".env", "MY_OWN_SECRET=1\n");
	const before = fs.readFileSync(path.join(dir, ".env"));
	const head = git(dir, "rev-parse", "HEAD");
	const r = move(dir, ["--yes"]);
	assert.strictEqual(r.code, 2, r.out + r.err);
	assert.match(r.err, /\.env/);
	assert.ok(fs.readFileSync(path.join(dir, ".env")).equals(before), ".env changed");
	assert.strictEqual(git(dir, "rev-parse", "HEAD"), head);
	assert.strictEqual(git(dir, "remote"), "origin");
	assert.strictEqual(git(dir, "for-each-ref", "refs/pi-crust-move"), "");
	assert.ok(!fs.existsSync(path.join(holder, "pi-crust-before-move.bundle")), "no backup should be made on refusal");
});

test("refuses (nothing changed) when the private-old remote already exists", () => {
	const { dir } = newClone();
	git(dir, "remote", "add", "private-old", "https://example.invalid/x.git");
	const head = git(dir, "rev-parse", "HEAD");
	const r = move(dir, ["--yes"]);
	assert.strictEqual(r.code, 2, r.out + r.err);
	assert.match(r.err, /private-old/);
	assert.strictEqual(git(dir, "rev-parse", "HEAD"), head);
	assert.strictEqual(git(dir, "remote").split("\n").sort().join(","), "origin,private-old");
});

test("refuses when the temporary remote points somewhere else", () => {
	const { dir } = newClone();
	git(dir, "remote", "add", "pi-crust-public-tmp", "https://example.invalid/other.git");
	const r = move(dir, ["--yes"]);
	assert.strictEqual(r.code, 2, r.out + r.err);
	assert.match(r.err, /pi-crust-public-tmp/);
});

test("moves a clean clone, prints the restore command, keeps non-colliding ignored files", () => {
	const { holder, dir } = newClone();
	write(dir, "src/local/mine.js", "// mine\n");
	const dry = move(dir);
	assert.strictEqual(dry.code, 0, dry.out + dry.err);
	assert.strictEqual(git(dir, "remote"), "origin", "dry run must not change remotes");
	const r = move(dir, ["--yes"]);
	assert.strictEqual(r.code, 0, r.out + r.err);
	const bundle = path.join(holder, "pi-crust-before-move.bundle");
	assert.ok(fs.existsSync(bundle));
	assert.match(r.out, /git clone ".*pi-crust-before-move\.bundle" restored-clone/);
	assert.strictEqual(git(dir, "rev-parse", "HEAD"), git(pubDir, "rev-parse", "HEAD"));
	assert.strictEqual(git(dir, "remote").split("\n").sort().join(","), "origin,private-old");
	assert.strictEqual(git(dir, "remote", "get-url", "origin"), pubDir);
	assert.strictEqual(fs.readFileSync(path.join(dir, "src/local/mine.js"), "utf8"), "// mine\n");
	assert.strictEqual(git(dir, "for-each-ref", "refs/pi-crust-move"), "");
	const again = move(dir, ["--yes"]);
	assert.strictEqual(again.code, 0);
	assert.match(again.out, /Already moved/);
});

test("--root from a subfolder resolves to the clone's top, so the bundle lands beside the clone", () => {
	const { holder, dir } = newClone();
	fs.mkdirSync(path.join(dir, "sub"));
	const r = move(path.join(dir, "sub"), ["--yes"]);
	assert.strictEqual(r.code, 0, r.out + r.err);
	assert.ok(fs.existsSync(path.join(holder, "pi-crust-before-move.bundle")));
	assert.ok(!fs.existsSync(path.join(dir, "pi-crust-before-move.bundle")));
});

test("--root or --public-url as the last argument without a value fails with usage", () => {
	for (const flag of ["--root", "--public-url"]) {
		const r = run([flag]);
		assert.strictEqual(r.code, 2, r.out + r.err);
		assert.match(r.err, /needs a value/);
		assert.match(r.err, /Usage/);
	}
});

test("a failed checkout says the clone is as it was only after checking, and names the backup", () => {
	const { dir } = newClone();
	fs.writeFileSync(path.join(dir, ".git", "index.lock"), ""); // makes the checkout fail
	const head = git(dir, "rev-parse", "HEAD");
	const r = move(dir, ["--yes"]);
	assert.strictEqual(r.code, 1, r.out + r.err);
	assert.match(r.err, /Checked: HEAD .* same as before/);
	assert.match(r.err, /pi-crust-before-move\.bundle/);
	assert.strictEqual(git(dir, "rev-parse", "HEAD"), head);
	assert.strictEqual(git(dir, "remote"), "origin");
});
