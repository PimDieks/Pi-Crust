// TRANSITION ONLY (remove after the 0.1.x apps are gone; at the earliest once every team member has updated to a
// release-based build, and no later than the 0.4.0 release).
// Apps built from 0.1.x update themselves by pulling this repo, running scripts/dist-win.js here and then looking for
// dist\Pi Crust Setup <version>.exe (scripts/update.js in that app's own build, line 107 at 0b62da5). The installer is now
// called Pi-Crust-Setup-<version>.exe, so those apps stopped with "Installer not found". After a successful LOCAL build,
// dist-win.js leaves a hard link (or a copy) under the old name so that update can finish.
// It is never created in a release build (CI=true or --release), so the release upload list, latest.yml, the checksums and
// the draft release never see it. scripts/checksums.js also skips this name.
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const legacyName = (version) => `Pi Crust Setup ${version}.exe`;
const currentName = (version) => `Pi-Crust-Setup-${version}.exe`;
const isLegacyName = (name) => /^Pi Crust Setup .+\.exe$/.test(name);

// Returns "link", "copy" or "none" (no installer to link to). Replaces an older file of the legacy name.
function linkLegacyInstaller(dist, version) {
	const from = path.join(dist, currentName(version));
	const to = path.join(dist, legacyName(version));
	if (!fs.existsSync(from)) return "none";
	fs.rmSync(to, { force: true });
	try {
		fs.linkSync(from, to);
		return "link";
	} catch {
		fs.copyFileSync(from, to);
		return "copy";
	}
}

module.exports = { legacyName, currentName, isLegacyName, linkLegacyInstaller };
