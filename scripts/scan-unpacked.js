#!/usr/bin/env node
// Leak scan of an unpacked installer folder (dist/win-unpacked), used by CI and the release workflow so the skip list
// lives in one place. `node scripts/scan-unpacked.js <folder> <deny-list file>`, or `<folder> --no-denylist` for the built-in
// secret patterns only (pull requests from forks and Dependabot, where the deny-list secret is not available).
// Our own files are scanned in full (names and text). Third-party content is skipped because it is not ours and the
// deny-list matches common words in it: bundled node_modules, Chromium locale and resource files, the Electron binary,
// and binary formats (random bytes). The binary-format skips (*.png, *.dat, ...) do NOT apply inside our own code:
// resources/app/src and the files directly in resources/app are scanned even when they are binary (binary-run scan).
// The run fails when resources/app/src is missing or holds fewer than MIN_JS .js files (a wrong folder or a broken build
// must not give a green scan), and prints the counts. Exit code and output are those of check-secrets.js (rule numbers
// only, never a word).
"use strict";
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const SKIP = ["resources/app/node_modules", "locales", "Pi Crust.exe", "*.pak", "*.dll", "*.dat", "*.bin", "*.png", "*.gif", "*.ico", "*.woff2"];
const APP = "resources/app";
const MIN_JS = 40; // src had 85 .js files when this was written; far fewer means the wrong folder

function countJs(dir) {
	let n = 0;
	for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, ent.name);
		if (ent.isSymbolicLink()) continue;
		if (ent.isDirectory()) n += countJs(full);
		else if (ent.isFile() && /\.js$/i.test(ent.name)) n++;
	}
	return n;
}

function main(dir, list) {
	const src = path.join(dir, APP, "src");
	if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) {
		process.stderr.write(`ERROR: ${APP}/src is missing in the folder, so the app's own code was not found. Failing the scan.\n`);
		return 1;
	}
	const js = countJs(src);
	const own = [`${APP}/src`];
	for (const ent of fs.readdirSync(path.join(dir, APP), { withFileTypes: true })) if (ent.isFile()) own.push(`${APP}/${ent.name}`);
	process.stderr.write(`Own code: ${js} .js files under ${APP}/src, ${own.length - 1} top-level files in ${APP}.\n`);
	if (js < MIN_JS) {
		process.stderr.write(`ERROR: only ${js} .js files under ${APP}/src (at least ${MIN_JS} expected). Failing the scan.\n`);
		return 1;
	}
	const deny = list === "--no-denylist" ? [] : ["--require-denylist", "--denylist", list];
	const args = [path.join(__dirname, "check-secrets.js"), "--dir", dir, ...deny, ...SKIP.flatMap((s) => ["--skip", s]), ...own.flatMap((o) => ["--own", o])];
	const r = spawnSync(process.execPath, args, { stdio: "inherit" });
	return r.status === null ? 1 : r.status;
}

if (require.main === module) {
	const [dir, list] = process.argv.slice(2);
	if (!dir || !list) {
		process.stderr.write("Usage: node scripts/scan-unpacked.js <folder> <deny-list file>\n");
		process.exit(2);
	}
	process.exit(main(dir, list));
}
module.exports = { main, MIN_JS };
