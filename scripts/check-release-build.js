#!/usr/bin/env node
// `node scripts/check-release-build.js <dist-dir> <version>`: checks that a release build carries what the in-app updater needs.
//   1. dist/win-unpacked/resources/app-update.yml exists (electron-builder writes it from build.publish; without it the installed
//      app cannot find its updates) and names the github provider.
//   2. dist/latest.yml says the same version as the tag, and names the installer.
//   3. the sha512 and size in latest.yml equal the real installer (the updater refuses a download that does not match).
// Exit 0 when all hold, 1 with one line per problem otherwise. No dependencies.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const scalar = (text, key) => {
	const m = text.match(new RegExp("^" + key + ":[ \t]*(.+?)[ \t\r]*$", "m"));
	return m ? m[1].replace(/^['"]|['"]$/g, "") : null;
};

function check(dist, version) {
	const problems = [];
	const installer = `Pi-Crust-Setup-${version}.exe`;
	const upd = path.join(dist, "win-unpacked", "resources", "app-update.yml");
	if (!fs.existsSync(upd)) problems.push(`app-update.yml is missing from win-unpacked/resources (the installed app could not look for updates).`);
	else if (scalar(fs.readFileSync(upd, "utf8"), "provider") !== "github") problems.push(`app-update.yml does not name the github provider.`);
	const latest = path.join(dist, "latest.yml");
	if (!fs.existsSync(latest)) problems.push(`latest.yml was not produced.`);
	else {
		const text = fs.readFileSync(latest, "utf8");
		const v = scalar(text, "version");
		if (v !== version) problems.push(`latest.yml says version ${v}, but the release is ${version}.`);
		if (!text.includes(installer)) problems.push(`latest.yml does not name ${installer}.`);
		const exe = path.join(dist, installer);
		if (!fs.existsSync(exe)) problems.push(`${installer} was not produced.`);
		else {
			const want = scalar(text, "sha512");
			const got = crypto.createHash("sha512").update(fs.readFileSync(exe)).digest("base64");
			if (want !== got) problems.push(`latest.yml sha512 does not match ${installer} (the updater would reject the download).`);
			const size = Number(text.match(/^\s+size:\s*(\d+)/m)?.[1]);
			if (size !== fs.statSync(exe).size) problems.push(`latest.yml size ${size} does not match ${installer} (${fs.statSync(exe).size}).`);
		}
	}
	return problems;
}

if (require.main === module) {
	const [dist, version] = process.argv.slice(2);
	if (!dist || !version) {
		process.stderr.write("Usage: node scripts/check-release-build.js <dist-dir> <version>\n");
		process.exit(1);
	}
	const problems = check(dist, version.replace(/^v/, ""));
	for (const p of problems) process.stderr.write(`${p}\n`);
	if (!problems.length) process.stdout.write(`Release build ok: app-update.yml present, latest.yml matches ${version} and the installer.\n`);
	process.exit(problems.length ? 1 : 0);
}
module.exports = { check };
