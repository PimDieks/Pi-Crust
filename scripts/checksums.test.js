"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SCRIPT = path.join(__dirname, "checksums.js");
const run = (...a) => spawnSync(process.execPath, [SCRIPT, ...a], { encoding: "utf8" });
let dir;
before(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "sums-"));
	fs.writeFileSync(path.join(dir, "Pi-Crust-Setup-1.0.0.exe"), "installer bytes");
	fs.writeFileSync(path.join(dir, "Pi-Crust-1.0.0.zip"), "zip bytes");
	fs.writeFileSync(path.join(dir, "latest.yml"), "manifest");
	fs.writeFileSync(path.join(dir, "Pi-Crust-Setup-1.0.0.exe.blockmap"), "map");
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

test("writes one line per installer, right hash, no manifest or blockmap", () => {
	const r = run(dir);
	assert.strictEqual(r.status, 0);
	const lines = fs.readFileSync(path.join(dir, "SHA256SUMS.txt"), "utf8").trim().split("\n");
	assert.strictEqual(lines.length, 2);
	const want = crypto.createHash("sha256").update("installer bytes").digest("hex");
	assert.ok(lines.includes(`${want}  Pi-Crust-Setup-1.0.0.exe`));
	assert.ok(!lines.join("").includes("latest.yml"));
	assert.ok(!lines.join("").includes("blockmap"));
});
test("a changed file gets a different hash", () => {
	const before = fs.readFileSync(path.join(dir, "SHA256SUMS.txt"), "utf8");
	fs.writeFileSync(path.join(dir, "Pi-Crust-Setup-1.0.0.exe"), "installer bytez");
	run(dir);
	assert.notStrictEqual(fs.readFileSync(path.join(dir, "SHA256SUMS.txt"), "utf8"), before);
});
test("empty folder and missing argument exit 1", () => {
	const e = fs.mkdtempSync(path.join(os.tmpdir(), "sums-e-"));
	assert.strictEqual(run(e).status, 1);
	assert.ok(!fs.existsSync(path.join(e, "SHA256SUMS.txt")));
	assert.strictEqual(run().status, 1);
	fs.rmSync(e, { recursive: true, force: true });
});
test("--notes prints the Get-FileHash line", () => {
	const r = run("--notes", dir);
	assert.strictEqual(r.status, 0);
	assert.match(r.stdout, /Get-FileHash \.\\Pi-Crust-Setup-1\.0\.0\.exe -Algorithm SHA256/);
});
