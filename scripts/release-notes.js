#!/usr/bin/env node
// `node scripts/release-notes.js <version> [changelog]`: prints the CHANGELOG.md section of one version to stdout
// (without its heading). Exit 1 when the section is missing or empty. A pre-release (0.2.0-rc.1) uses its own
// section if there is one, else the section of the version it leads up to (0.2.0).
"use strict";
const fs = require("node:fs");
const path = require("node:path");

function extract(text, version) {
	const lines = text.split(/\r?\n/);
	const esc = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const head = new RegExp(`^##\\s+\\[?v?${esc}\\]?(\\s|$)`);
	const start = lines.findIndex((l) => head.test(l));
	if (start < 0) return null;
	let end = lines.findIndex((l, i) => i > start && /^##\s/.test(l));
	if (end < 0) end = lines.length;
	return lines.slice(start + 1, end).join("\n").trim();
}

function notes(text, version) {
	let body = extract(text, version);
	if (body === null && /-/.test(version)) body = extract(text, version.replace(/-.*$/, ""));
	return body;
}

if (require.main === module) {
	const version = (process.argv[2] || "").replace(/^v/, "");
	if (!version) {
		process.stderr.write("Usage: node scripts/release-notes.js <version> [changelog file]\n");
		process.exit(1);
	}
	const file = process.argv[3] || path.join(__dirname, "..", "CHANGELOG.md");
	let text;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch (e) {
		process.stderr.write(`Cannot read ${file}: ${e.message}\n`);
		process.exit(1);
	}
	const body = notes(text, version);
	if (!body) {
		process.stderr.write(`No release notes for ${version} in ${path.basename(file)} (section missing or empty).\n`);
		process.exit(1);
	}
	process.stdout.write(body + "\n");
}
module.exports = { notes, extract };
