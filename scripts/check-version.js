#!/usr/bin/env node
// `node scripts/check-version.js <tag>`: checks that a release tag (v0.2.0, v0.2.0-rc.1) matches the version in package.json.
// Exit 0 on a match, 1 on a mismatch or bad input. package.json is the only place the version lives; package-lock.json
// carries a copy of it that must agree (npm writes it, a missed bump would ship a stale lockfile).
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function check(tag, pkgVersion, lockVersion) {
	if (!/^v/.test(tag || "")) return { ok: false, message: `Tag "${tag || ""}" must start with "v" (for example v${pkgVersion}).` };
	const v = tag.slice(1);
	if (!SEMVER.test(v)) return { ok: false, message: `Tag "${tag}" is not a version tag (vX.Y.Z or vX.Y.Z-rc.N).` };
	if (v !== pkgVersion) return { ok: false, message: `Tag ${tag} is version ${v}, but package.json says ${pkgVersion}. Bump package.json or fix the tag.` };
	if (lockVersion !== undefined && lockVersion !== pkgVersion) return { ok: false, message: `package-lock.json says ${lockVersion}, but package.json says ${pkgVersion}. Run npm install --package-lock-only to refresh it.` };
	return { ok: true, message: `Tag ${tag} matches package.json (${pkgVersion}).` };
}

if (require.main === module) {
	const tag = process.argv[2];
	if (!tag) {
		process.stderr.write("Usage: node scripts/check-version.js <tag>\n");
		process.exit(1);
	}
	const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
	let lockVersion;
	try {
		const lock = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package-lock.json"), "utf8"));
		lockVersion = lock.packages?.[""]?.version ?? lock.version;
	} catch {
		lockVersion = null; // missing or unreadable lockfile counts as a mismatch
	}
	const r = check(tag, pkg.version, lockVersion);
	(r.ok ? process.stdout : process.stderr).write(r.message + "\n");
	process.exit(r.ok ? 0 : 1);
}
module.exports = { check };
