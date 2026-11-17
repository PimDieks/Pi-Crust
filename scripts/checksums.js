#!/usr/bin/env node
// `node scripts/checksums.js <dir>`: writes <dir>/SHA256SUMS.txt with "<sha256>  <file name>" (the format `sha256sum -c`
// reads) for every installer in the folder (.exe, .zip, .dmg). Not latest.yml (a manifest) and not .blockmap files.
// Run it AFTER signing: signing changes the file, so a hash taken before would not match the download.
// `node scripts/checksums.js --notes <dir>` prints the release-notes block that tells people how to check a download.
// Exits 1 when the folder has no installer, so a release can never ship an empty checksum file.
"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const INSTALLER = /\.(exe|zip|dmg)$/i;

function listInstallers(dir) {
	return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && INSTALLER.test(e.name)).map((e) => e.name).sort();
}
function sha256(file) {
	const h = crypto.createHash("sha256");
	const fd = fs.openSync(file, "r");
	try {
		const buf = Buffer.allocUnsafe(1 << 20);
		let n;
		while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
	} finally {
		fs.closeSync(fd);
	}
	return h.digest("hex");
}
function build(dir) {
	const files = listInstallers(dir);
	if (!files.length) throw new Error(`No installer (.exe, .zip, .dmg) in ${dir}.`);
	return files.map((f) => `${sha256(path.join(dir, f))}  ${f}`).join("\n") + "\n";
}
function notes(dir) {
	const lines = listInstallers(dir).filter((f) => /\.exe$/i.test(f)).map((f) => `Get-FileHash .\\${f} -Algorithm SHA256`);
	if (!lines.length) throw new Error(`No installer (.exe) in ${dir}.`);
	return ["**Check your download** (PowerShell). The hash must equal the line for this file in `SHA256SUMS.txt`:", "", "```powershell", ...lines, "```", ""].join("\n");
}

if (require.main === module) {
	const args = process.argv.slice(2);
	const wantNotes = args[0] === "--notes";
	const dir = wantNotes ? args[1] : args[0];
	if (!dir) {
		process.stderr.write("Usage: node scripts/checksums.js <dir>   |   node scripts/checksums.js --notes <dir>\n");
		process.exit(1);
	}
	try {
		if (wantNotes) process.stdout.write(notes(dir));
		else {
			const text = build(dir);
			fs.writeFileSync(path.join(dir, "SHA256SUMS.txt"), text);
			process.stdout.write(text);
		}
	} catch (e) {
		process.stderr.write(e.message + "\n");
		process.exit(1);
	}
}
module.exports = { build, notes, sha256, listInstallers };
