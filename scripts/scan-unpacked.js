#!/usr/bin/env node
// Leak scan of an unpacked installer folder (dist/win-unpacked), used by CI and the release workflow so the skip list
// lives in one place. `node scripts/scan-unpacked.js <folder> <deny-list file>`.
// Our own files are scanned in full (names and text). Third-party content is skipped because it is not ours and the
// deny-list matches common words in it: bundled node_modules, Chromium locale and resource files, the Electron binary,
// and binary formats (random bytes). Exit code and output are those of check-secrets.js (rule numbers only, never a word).
"use strict";
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const SKIP = ["resources/app/node_modules", "locales", "Pi Crust.exe", "*.pak", "*.dll", "*.dat", "*.bin", "*.png", "*.gif", "*.ico", "*.woff2"];

const [dir, list] = process.argv.slice(2);
if (!dir || !list) {
	process.stderr.write("Usage: node scripts/scan-unpacked.js <folder> <deny-list file>\n");
	process.exit(2);
}
const args = [path.join(__dirname, "check-secrets.js"), "--dir", dir, "--require-denylist", "--denylist", list, ...SKIP.flatMap((s) => ["--skip", s])];
const r = spawnSync(process.execPath, args, { stdio: "inherit" });
process.exit(r.status === null ? 1 : r.status);
