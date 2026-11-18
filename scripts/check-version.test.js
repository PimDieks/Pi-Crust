"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { check } = require("./check-version.js");

const SCRIPT = path.join(__dirname, "check-version.js");
const run = (...a) => spawnSync(process.execPath, [SCRIPT, ...a], { encoding: "utf8" });

test("matching tag passes, including rc tags against an rc version", () => {
	assert.ok(check("v0.2.0", "0.2.0").ok);
	assert.ok(check("v0.2.0-rc.1", "0.2.0-rc.1").ok);
});
test("mismatch names both versions", () => {
	const r = check("v0.9.9", "0.2.0");
	assert.ok(!r.ok);
	assert.match(r.message, /0\.9\.9/);
	assert.match(r.message, /0\.2\.0/);
});
test("tag without v, or not a version, fails", () => {
	assert.ok(!check("0.2.0", "0.2.0").ok);
	assert.ok(!check("vfoo", "0.2.0").ok);
	assert.ok(!check("", "0.2.0").ok);
});
test("cli: exit 1 without argument and on mismatch", () => {
	assert.strictEqual(run().status, 1);
	assert.strictEqual(run("v0.0.1").status, 1);
});

test("lockfile version must equal package.json, and the message says so", () => {
	assert.ok(check("v0.2.0", "0.2.0", "0.2.0").ok);
	const r = check("v0.2.0", "0.2.0", "0.1.9");
	assert.ok(!r.ok);
	assert.match(r.message, /package-lock\.json says 0\.1\.9/);
	assert.ok(!check("v0.2.0", "0.2.0", null).ok);
});
test("cli: passes on this repo (lockfile agrees with package.json)", () => {
	const v = require("../package.json").version;
	assert.strictEqual(run(`v${v}`).status, 0);
});
