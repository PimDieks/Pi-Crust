"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { legacyName, currentName, isLegacyName, linkLegacyInstaller } = require("./legacy-installer-name.js");
const checksums = require("./checksums.js");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "lin-"));

test("names: old app looks for 'Pi Crust Setup <v>.exe', the build makes 'Pi-Crust-Setup-<v>.exe'", () => {
	assert.strictEqual(legacyName("0.2.0"), "Pi Crust Setup 0.2.0.exe");
	assert.strictEqual(currentName("0.2.0"), "Pi-Crust-Setup-0.2.0.exe");
	assert.ok(isLegacyName("Pi Crust Setup 0.2.0.exe"));
	assert.ok(!isLegacyName("Pi-Crust-Setup-0.2.0.exe"));
});
test("the legacy file has the same bytes as the installer; running it twice is fine", () => {
	const d = tmp();
	fs.writeFileSync(path.join(d, currentName("0.2.0")), "installer bytes");
	assert.match(linkLegacyInstaller(d, "0.2.0"), /^(link|copy)$/);
	assert.match(linkLegacyInstaller(d, "0.2.0"), /^(link|copy)$/);
	assert.strictEqual(fs.readFileSync(path.join(d, legacyName("0.2.0")), "utf8"), "installer bytes");
});
test("no installer: nothing is made", () => {
	const d = tmp();
	assert.strictEqual(linkLegacyInstaller(d, "0.2.0"), "none");
	assert.deepStrictEqual(fs.readdirSync(d), []);
});
test("checksums never list the legacy name", () => {
	const d = tmp();
	fs.writeFileSync(path.join(d, currentName("0.2.0")), "x");
	linkLegacyInstaller(d, "0.2.0");
	assert.ok(!/Pi Crust Setup/.test(checksums.build(d)), checksums.build(d));
});
test("dist-win.js makes the legacy file only for a local build", () => {
	const src = fs.readFileSync(path.join(__dirname, "dist-win.js"), "utf8");
	assert.match(src, /r\.status === 0 && !release\)\s*\{[^}]*linkLegacyInstaller/);
});
test("the release workflow uploads named files only: never the legacy name, never a dist glob", () => {
	const yml = fs.readFileSync(path.join(__dirname, "..", ".github", "workflows", "release.yml"), "utf8");
	assert.ok(!/Pi Crust Setup/.test(yml));
	const create = yml.slice(yml.indexOf("gh release create"));
	const uploads = create.split("\n").slice(0, 8).filter((l) => /dist[\/]/.test(l)).join("\n");
	assert.match(uploads, /Pi-Crust-Setup-\$VERSION\.exe/);
	assert.ok(!/\*/.test(uploads), uploads);
});
