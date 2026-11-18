"use strict";
// Pi lookup (src/agents/pi/locate.js, moved out of main.js in phase 6): fixture folders, no real Pi involved.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const L = require("../src/agents/pi/locate");
const { pathKey, onPath } = require("../src/env-path");

const WIN = process.platform === "win32";
const KEYS = ["PI_CRUST_PI", "APPDATA", "NVM_HOME", "NVM_SYMLINK", "PATH", "Path", "HOME", "USERPROFILE", "ProgramFiles", "LOCALAPPDATA"];

function withEnv(set, fn) {
	const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
	for (const k of KEYS) delete process.env[k];
	Object.assign(process.env, set);
	try {
		return fn();
	} finally {
		for (const k of KEYS) delete process.env[k];
		for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
	}
}
const tmp = () => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "pi-locate-")));
const put = (f, text = "") => (fs.mkdirSync(path.dirname(f), { recursive: true }), fs.writeFileSync(f, text), f);
function pkg(prefix, name, bin = "dist/cli.js") {
	const dir = path.join(prefix, "node_modules", ...name.split("/"));
	put(path.join(dir, "package.json"), JSON.stringify({ name, bin: { pi: bin } }));
	return put(path.join(dir, bin), "// cli");
}

test("pathExtras: the Pi folder, or nothing", () => {
	assert.deepStrictEqual(L.pathExtras({ binDir: "/x/bin", command: "c", args: [] }), ["/x/bin"]);
	assert.deepStrictEqual(L.pathExtras(null), []);
});

test("env-path: pathKey keeps the spelling, onPath finds a file in PATH", () => {
	assert.strictEqual(pathKey({ Path: "a" }), "Path");
	assert.strictEqual(pathKey({ X: "a" }), "PATH");
	const d = tmp();
	const f = put(path.join(d, "tool.exe"));
	assert.strictEqual(onPath("tool.exe", { PATH: ["/nope", `"${d}"`].join(path.delimiter) }), f);
	assert.strictEqual(onPath("missing.exe", { PATH: d }), null);
});

test("posix lookup: PI_CRUST_PI first, then nvm default, then none", () => {
	const home = tmp();
	const given = put(path.join(home, "given", "pi"));
	const nvmBin = path.join(home, ".nvm", "versions", "node", "v22.1.0", "bin");
	put(path.join(home, ".nvm", "alias", "default"), "22.1.0\n");
	put(path.join(nvmBin, "pi"));
	withEnv({ HOME: home, USERPROFILE: home, PI_CRUST_PI: given }, () => {
		assert.deepStrictEqual(L.locatePosix(), { binDir: path.dirname(given), command: given, args: [] });
	});
	withEnv({ HOME: home, USERPROFILE: home }, () => {
		assert.deepStrictEqual(L.locatePosix(), { binDir: nvmBin, command: path.join(nvmBin, "pi"), args: [] });
	});
	const empty = tmp();
	withEnv({ HOME: empty, USERPROFILE: empty }, () => {
		const r = L.locatePosix();
		// only the system-wide folders could still match on a machine that has Pi there
		if (r) assert.ok(/^\/(opt\/homebrew|usr\/local)\/bin$/.test(r.binDir.replace(/\\/g, "/")));
	});
});

test("posix lookup: a JS entry point runs with the Node next to it; newest nvm version wins", () => {
	const home = tmp();
	const nvm = path.join(home, ".nvm", "versions", "node");
	for (const v of ["v20.9.0", "v22.1.0", "v22.10.0"]) {
		put(path.join(nvm, v, "bin", "node"));
		put(path.join(nvm, v, "lib", "cli.js"), "//");
		fs.writeFileSync(path.join(nvm, v, "bin", "pi.js"), "//");
	}
	const cli = path.join(nvm, "v22.10.0", "lib", "cli.js");
	fs.rmSync(path.join(nvm, "v22.10.0", "bin", "pi.js"));
	try {
		fs.symlinkSync(cli, path.join(nvm, "v22.10.0", "bin", "pi"));
	} catch {
		return; // no symlink right on this machine: the cases above still ran
	}
	withEnv({ HOME: home, USERPROFILE: home }, () => {
		const r = L.locatePosix();
		assert.strictEqual(r.binDir, path.join(nvm, "v22.10.0", "bin"));
		assert.strictEqual(r.command, path.join(nvm, "v22.10.0", "bin", "node"));
		assert.deepStrictEqual(r.args, [fs.realpathSync(cli)]);
	});
});

test("windows lookup: PI_CRUST_PI as .js, .exe and .cmd", { skip: !WIN }, () => {
	const d = tmp();
	put(path.join(d, "node.exe"));
	const js = put(path.join(d, "cli.js"));
	withEnv({ PI_CRUST_PI: js, PATH: d }, () => assert.deepStrictEqual(L.findPiWin(), { binDir: d, command: path.join(d, "node.exe"), args: [js] }));
	const exe = put(path.join(d, "pi.exe"));
	withEnv({ PI_CRUST_PI: exe, PATH: d }, () => assert.deepStrictEqual(L.findPiWin(), { binDir: d, command: exe, args: [] }));
	const cmd = put(path.join(d, "pi.cmd"), '@echo off\r\n"%dp0%\\node_modules\\x\\dist\\cli.js" %*\r\n');
	const script = put(path.join(d, "node_modules", "x", "dist", "cli.js"));
	withEnv({ PI_CRUST_PI: cmd, PATH: d }, () => assert.deepStrictEqual(L.findPiWin(), { binDir: d, command: path.join(d, "node.exe"), args: [script] }));
});

test("windows lookup: npm prefix, both package scopes (current first), nvm newest first, PATH shim, nothing", { skip: !WIN }, () => {
	const a = tmp();
	const empty = tmp();
	put(path.join(a, "npm", "node.exe"));
	const cur = pkg(path.join(a, "npm"), "@earendil-works/pi-coding-agent");
	pkg(path.join(a, "npm"), "@mariozechner/pi-coding-agent");
	withEnv({ APPDATA: a, PATH: empty, NVM_HOME: empty }, () => assert.deepStrictEqual(L.findPiWin(), { binDir: path.join(a, "npm"), command: path.join(a, "npm", "node.exe"), args: [cur] }));

	const b = tmp();
	put(path.join(b, "npm", "node.exe"));
	const old = pkg(path.join(b, "npm"), "@mariozechner/pi-coding-agent");
	withEnv({ APPDATA: b, PATH: empty, NVM_HOME: empty }, () => assert.strictEqual(L.findPiWin().args[0], old));

	const n = tmp();
	for (const v of ["v20.9.0", "v22.1.0", "v22.10.0"]) put(path.join(n, v, "node.exe"));
	pkg(path.join(n, "v22.1.0"), "@earendil-works/pi-coding-agent");
	const newest = pkg(path.join(n, "v22.10.0"), "@earendil-works/pi-coding-agent");
	withEnv({ APPDATA: empty, PATH: empty, NVM_HOME: n }, () => assert.deepStrictEqual(L.findPiWin(), { binDir: path.join(n, "v22.10.0"), command: path.join(n, "v22.10.0", "node.exe"), args: [newest] }));

	const s = tmp();
	put(path.join(s, "node.exe"));
	put(path.join(s, "pi.cmd"), '"%dp0%\\node_modules\\p\\cli.js"');
	const sc = put(path.join(s, "node_modules", "p", "cli.js"));
	withEnv({ APPDATA: empty, PATH: s, NVM_HOME: empty }, () => assert.deepStrictEqual(L.findPiWin(), { binDir: s, command: path.join(s, "node.exe"), args: [sc] }));

	withEnv({ APPDATA: empty, PATH: empty, NVM_HOME: empty, ProgramFiles: empty, LOCALAPPDATA: empty }, () => assert.strictEqual(L.findPiWin(), null));
});

test("PI_CRUST_PI is a documented user setting (README), so the lookup honours it in every mode, not only in selftest", () => {
	const readme = fs.readFileSync(path.join(__dirname, "..", "README.md"), "utf8");
	assert.match(readme, /\|\s*`PI_CRUST_PI`\s*\|/);
	const src = fs.readFileSync(path.join(__dirname, "..", "src", "agents", "pi", "locate.js"), "utf8");
	assert.ok(!/SELFTEST/.test(src), "locate.js has no selftest gate on PI_CRUST_PI");
});
