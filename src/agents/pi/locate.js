// Finding the Pi program (phase 6: moved out of main.js, same lookup order and results). Pure with respect to the app: it reads
// the environment, the home folder and the disk, nothing else. The caller (main.js) keeps the cache and the selftest switch.
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { nvmWinHome, onPath } = require("../../env-path");

const IS_WIN = process.platform === "win32";

// Where Pi is installed, independent of the opened repo: PI_CRUST_PI, nvm's default version, any other nvm
// version (newest first), then Homebrew / ~/.local. Returns the resolved CLI script and the Node next to it, so Pi
// always runs on the Node it was installed with, whatever the repo's .nvmrc says.
function locatePosix() {
	const home = os.homedir();
	const nvmDir = path.join(home, ".nvm", "versions", "node");
	const candidates = [];
	if (process.env.PI_CRUST_PI) candidates.push(process.env.PI_CRUST_PI);
	try {
		const def = fs.readFileSync(path.join(home, ".nvm", "alias", "default"), "utf8").trim().replace(/^v/, "");
		candidates.push(path.join(nvmDir, `v${def}`, "bin", "pi"));
	} catch {}
	try {
		const versions = fs.readdirSync(nvmDir).filter((v) => /^v\d/.test(v));
		const num = (v) => v.slice(1).split(".").map(Number);
		versions.sort((a, b) => {
			const [x, y] = [num(a), num(b)];
			for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return y[i] - x[i];
			return 0;
		});
		for (const v of versions) candidates.push(path.join(nvmDir, v, "bin", "pi"));
	} catch {}
	candidates.push("/opt/homebrew/bin/pi", "/usr/local/bin/pi", path.join(home, ".local", "bin", "pi"));
	for (const bin of candidates) {
		if (!fs.existsSync(bin)) continue;
		const binDir = path.dirname(bin);
		const nodeHere = path.join(binDir, "node");
		let script = null;
		try {
			script = fs.realpathSync(bin);
		} catch {}
		// A JS entry point next to a Node binary: run it with that Node. Otherwise run the binary as is.
		if (script && fs.existsSync(nodeHere) && /\.(c|m)?js$/.test(script)) {
			return { binDir, command: nodeHere, args: [script] };
		}
		return { binDir, command: bin, args: [] };
	}
	return null;
}

// Windows: PI_CRUST_PI (cli.js, pi.cmd or pi.exe), npm's global folder (%APPDATA%\npm), nvm-windows (the active
// %NVM_SYMLINK%, then %NVM_HOME%\vX newest first), then PATH. Never through the pi.cmd shim (a .cmd only runs in a
// shell, which breaks stdio and arguments): its CLI script runs with the node.exe next to it, else the one on PATH.
const PI_PACKAGES = [require("../../pi-package").PI_PACKAGE.name, ...require("../../pi-package").PI_OLD_NAMES].map((n) => path.join(...n.split("/"))); // current scope first; the deprecated one is still found (see pi-package.js)
// pi.cmd (npm's cmd-shim) -> the script it runs: "%dp0%\node_modules\...\cli.js".
function scriptOfShim(cmd) {
	try {
		const m = /"%dp0%\\([^"]+?\.[cm]?js)"/i.exec(fs.readFileSync(cmd, "utf8"));
		return m ? path.join(path.dirname(cmd), m[1]) : null;
	} catch {
		return null;
	}
}
// <prefix>\node_modules\<pkg>\package.json "bin" -> the CLI script.
function scriptOfPrefix(prefix) {
	for (const pkg of PI_PACKAGES) {
		const dir = path.join(prefix, "node_modules", pkg);
		try {
			const bin = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).bin;
			const rel = typeof bin === "string" ? bin : bin && bin.pi;
			if (rel && fs.existsSync(path.join(dir, rel))) return path.join(dir, rel);
		} catch {}
	}
	return null;
}
function findPiWin() {
	const usualNode = () => [process.env.ProgramFiles && path.join(process.env.ProgramFiles, "nodejs", "node.exe"), process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "nodejs", "node.exe")].find((p) => p && fs.existsSync(p)) || null; // a Node installed after the app started isn't on its PATH yet
	const nodeFor = (binDir) => (fs.existsSync(path.join(binDir, "node.exe")) ? path.join(binDir, "node.exe") : onPath("node.exe") || usualNode());
	const viaScript = (binDir, script) => {
		const node = script && nodeFor(binDir);
		return node ? { binDir, command: node, args: [script] } : null;
	};
	const given = process.env.PI_CRUST_PI;
	if (given && fs.existsSync(given)) {
		if (/\.exe$/i.test(given)) return { binDir: path.dirname(given), command: given, args: [] };
		const script = /\.(cmd|bat)$/i.test(given) ? scriptOfShim(given) : given;
		const r = viaScript(path.dirname(given), script);
		if (r) return r;
	}
	const prefixes = [];
	if (process.env.APPDATA) prefixes.push(path.join(process.env.APPDATA, "npm"));
	if (process.env.NVM_SYMLINK) prefixes.push(process.env.NVM_SYMLINK);
	try {
		const home = nvmWinHome();
		const versions = fs.readdirSync(home).filter((v) => /^v\d/.test(v));
		const num = (v) => v.slice(1).split(".").map(Number);
		versions.sort((a, b) => {
			const [x, y] = [num(a), num(b)];
			for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return y[i] - x[i];
			return 0;
		});
		for (const v of versions) prefixes.push(path.join(home, v));
	} catch {}
	for (const prefix of prefixes) {
		const r = viaScript(prefix, scriptOfPrefix(prefix));
		if (r) return r;
	}
	const shim = onPath("pi.cmd");
	if (shim) {
		const r = viaScript(path.dirname(shim), scriptOfShim(shim) || scriptOfPrefix(path.dirname(shim)));
		if (r) return r;
	}
	const exe = onPath("pi.exe");
	return exe ? { binDir: path.dirname(exe), command: exe, args: [] } : null;
}

// Folders the Pi program adds to PATH for every child (Pi's own bin last, see buildEnv in main.js).
const pathExtras = (located) => (located ? [located.binDir] : []);

module.exports = { locate: IS_WIN ? findPiWin : locatePosix, locatePosix, findPiWin, scriptOfShim, scriptOfPrefix, pathExtras };
