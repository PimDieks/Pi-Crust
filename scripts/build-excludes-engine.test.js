// The Claude engine (about 360 MB) must never ship in the installer. package.json's build.files keeps it out with a name glob for the
// SDK's per-platform packages. This test reads package-lock.json and fails when any @anthropic-ai/* package that carries a native
// engine (a platform-restricted or optional package, or one the SDK lists as an optional dependency) is not covered by an exclusion,
// for instance after an SDK update that renames its platform packages. The SDK itself and plain JavaScript packages
// (@anthropic-ai/sdk) are meant to ship.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const SDK_KEY = "node_modules/@anthropic-ai/claude-agent-sdk";

// A small glob for the patterns electron-builder takes here: ** (any depth), * (inside one folder name), ? and {a,b}.
function globToRegExp(glob) {
	let re = "";
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (c === "*" && glob[i + 1] === "*") {
			re += ".*";
			i++;
			if (glob[i + 1] === "/") i++; // "**/" also matches nothing
		} else if (c === "*") re += "[^/]*";
		else if (c === "?") re += "[^/]";
		else if (c === "{") {
			const end = glob.indexOf("}", i);
			re += `(?:${glob.slice(i + 1, end).split(",").map((x) => x.replace(/[.+^$()|[\]\\]/g, "\\$&")).join("|")})`;
			i = end;
		} else re += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`^${re}$`);
}

// Every lock entry that carries an engine, as { key, why }.
function enginePackages(lock) {
	const sdk = lock.packages?.[SDK_KEY];
	const listed = new Set(Object.keys(sdk?.optionalDependencies || {}));
	const out = [];
	for (const [key, meta] of Object.entries(lock.packages || {})) {
		const m = /(?:^|\/)node_modules\/(@anthropic-ai\/[^/]+)$/.exec(key);
		if (!m || key === SDK_KEY) continue;
		if (listed.has(m[1])) out.push({ key, why: "optional dependency of the SDK" });
		else if (meta.os || meta.cpu) out.push({ key, why: "platform-restricted" });
		else if (meta.optional) out.push({ key, why: "optional" });
	}
	return out;
}

// The engine packages whose files are not matched by any "!" exclusion in build.files.
function uncovered(lock, files) {
	const excludes = files.filter((f) => typeof f === "string" && f.startsWith("!")).map((f) => globToRegExp(f.slice(1)));
	return enginePackages(lock)
		.filter(({ key }) => !["claude.exe", "claude", "package.json", "cli.js"].every((f) => excludes.some((re) => re.test(`${key}/${f}`))))
		.map((e) => e.key);
}

const lock = JSON.parse(fs.readFileSync(path.join(ROOT, "package-lock.json"), "utf8"));
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

test("every engine package in package-lock.json is excluded from the build", () => {
	const found = enginePackages(lock);
	assert.ok(found.length >= 8, `expected the SDK's platform packages in the lock file, found ${found.length}`);
	assert.deepEqual(uncovered(lock, pkg.build.files), []);
});

test("the SDK itself and plain JavaScript packages are not mistaken for engines", () => {
	const keys = enginePackages(lock).map((e) => e.key);
	assert.ok(!keys.includes(SDK_KEY));
	assert.ok(!keys.includes("node_modules/@anthropic-ai/sdk"));
});

test("the check itself: a renamed platform package, or a missing exclusion, is reported", () => {
	const base = { packages: { [SDK_KEY]: { optionalDependencies: { "@anthropic-ai/claude-agent-sdk-win32-x64": "1.0.0" } } } };
	const files = ["src/**/*", "!node_modules/@anthropic-ai/claude-agent-sdk-*/**"];
	const withPkg = (name, meta) => ({ packages: { ...base.packages, [`node_modules/@anthropic-ai/${name}`]: meta } });
	// covered by the current glob
	assert.deepEqual(uncovered(withPkg("claude-agent-sdk-win32-x64", { cpu: ["x64"] }), files), []);
	// a later SDK renames its platform packages: the name glob no longer matches them
	assert.deepEqual(uncovered(withPkg("claude-engine-win32-x64", { os: ["win32"], cpu: ["x64"] }), files), ["node_modules/@anthropic-ai/claude-engine-win32-x64"]);
	assert.deepEqual(uncovered(withPkg("claude-engine-win32-x64", { optional: true }), files), ["node_modules/@anthropic-ai/claude-engine-win32-x64"]);
	// the exclusion removed altogether
	assert.deepEqual(uncovered(withPkg("claude-agent-sdk-win32-x64", { cpu: ["x64"] }), ["src/**/*"]), ["node_modules/@anthropic-ai/claude-agent-sdk-win32-x64"]);
	// a broader glob is fine
	assert.deepEqual(uncovered(withPkg("claude-engine-win32-x64", { os: ["win32"] }), ["!node_modules/@anthropic-ai/claude-*/**"]), []);
});
