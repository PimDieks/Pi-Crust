#!/usr/bin/env node
// `node scripts/check-version.js <tag>`: checks that a release tag (v0.2.0, v0.2.0-rc.1) matches the version in package.json.
// Exit 0 on a match, 1 on a mismatch or bad input. package.json is the only place the version lives.
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function check(tag, pkgVersion) {
	if (!/^v/.test(tag || "")) return { ok: false, message: `Tag "${tag || ""}" must start with "v" (for example v${pkgVersion}).` };
	const v = tag.slice(1);
	if (!SEMVER.test(v)) return { ok: false, message: `Tag "${tag}" is not a version tag (vX.Y.Z or vX.Y.Z-rc.N).` };
	if (v !== pkgVersion) return { ok: false, message: `Tag ${tag} is version ${v}, but package.json says ${pkgVersion}. Bump package.json or fix the tag.` };
	return { ok: true, message: `Tag ${tag} matches package.json (${pkgVersion}).` };
}

if (require.main === module) {
	const tag = process.argv[2];
	if (!tag) {
		process.stderr.write("Usage: node scripts/check-version.js <tag>\n");
		process.exit(1);
	}
	const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
	const r = check(tag, pkg.version);
	(r.ok ? process.stdout : process.stderr).write(r.message + "\n");
	process.exit(r.ok ? 0 : 1);
}
module.exports = { check };
