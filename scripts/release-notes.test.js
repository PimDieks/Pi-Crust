"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { notes } = require("./release-notes.js");

const SCRIPT = path.join(__dirname, "release-notes.js");
const LOG = "# Changelog\n\n## [Unreleased]\n\n## [0.2.0] - 2026-01-01\n\n- one\n- two\n\n## [0.1.0] - 2025-01-01\n\n- old\n\n## [0.0.9] - 2024-01-01\n\n";

test("returns only the requested section", () => {
	assert.strictEqual(notes(LOG, "0.2.0"), "- one\n- two");
	assert.strictEqual(notes(LOG, "0.1.0"), "- old");
});
test("missing or empty section gives nothing", () => {
	assert.ok(!notes(LOG, "9.9.9"));
	assert.ok(!notes(LOG, "0.0.9"));
	assert.ok(!notes(LOG, "Unreleased"));
});
test("rc falls back to its release section", () => {
	assert.strictEqual(notes(LOG, "0.2.0-rc.1"), "- one\n- two");
});
test("cli: exit codes and output", () => {
	const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rn-")), "CHANGELOG.md");
	fs.writeFileSync(f, LOG);
	const ok = spawnSync(process.execPath, [SCRIPT, "v0.2.0", f], { encoding: "utf8" });
	assert.strictEqual(ok.status, 0);
	assert.strictEqual(ok.stdout, "- one\n- two\n");
	assert.strictEqual(spawnSync(process.execPath, [SCRIPT, "9.9.9", f], { encoding: "utf8" }).status, 1);
	assert.strictEqual(spawnSync(process.execPath, [SCRIPT, "0.0.9", f], { encoding: "utf8" }).status, 1);
});
