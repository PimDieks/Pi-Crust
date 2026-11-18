"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { check } = require("./check-release-build.js");

function dist({ version = "0.2.1", yml = "provider: github\nowner: x\nrepo: y\n", latestVersion = version, tamper = false } = {}) {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "crb-"));
	const body = Buffer.from("installer bytes");
	const name = `Pi-Crust-Setup-${version}.exe`;
	fs.writeFileSync(path.join(d, name), body);
	if (yml !== null) {
		fs.mkdirSync(path.join(d, "win-unpacked", "resources"), { recursive: true });
		fs.writeFileSync(path.join(d, "win-unpacked", "resources", "app-update.yml"), yml);
	}
	const sha = crypto.createHash("sha512").update(tamper ? "other" : body).digest("base64");
	fs.writeFileSync(path.join(d, "latest.yml"), `version: ${latestVersion}\nfiles:\n  - url: ${name}\n    sha512: ${sha}\n    size: ${body.length}\npath: ${name}\nsha512: ${sha}\n`);
	return d;
}

test("a good build passes", () => assert.deepStrictEqual(check(dist(), "0.2.1"), []));
test("missing app-update.yml fails", () => assert.match(check(dist({ yml: null }), "0.2.1").join("\n"), /app-update\.yml is missing/));
test("latest.yml with another version fails and names both", () => assert.match(check(dist({ latestVersion: "0.2.0" }), "0.2.1").join("\n"), /says version 0\.2\.0.*0\.2\.1/));
test("latest.yml sha512 that does not match the installer fails", () => assert.match(check(dist({ tamper: true }), "0.2.1").join("\n"), /sha512 does not match/));
test("app-update.yml without the github provider fails", () => assert.match(check(dist({ yml: "provider: generic\n" }), "0.2.1").join("\n"), /github provider/));

const SIGNED = ["provider: github", "owner: x", "repo: y", "publisherName:", "  - Nullvorm", ""].join("\n");
const text = (opts, signed) => check(dist(opts), "0.2.1", { signed }).join(" | ");
test("signed build without publisherName fails", () => assert.match(text({}, true), /no publisherName/));
test("signed build with publisherName passes", () => assert.strictEqual(text({ yml: SIGNED }, true), ""));
test("unsigned build with publisherName fails", () => assert.match(text({ yml: SIGNED }, false), /unsigned but app-update/));
test("unsigned build without publisherName passes", () => assert.strictEqual(text({}, false), ""));
