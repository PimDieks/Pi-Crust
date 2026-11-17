#!/usr/bin/env node
// `npm run dist:mac` (on a Mac): builds dist/Pi Crust-<version>-<arch>.dmg for this Mac's architecture, plus the app
// itself in dist/mac*/Pi Crust.app. Extra arguments go to electron-builder (`npm run dist:mac -- --dir` builds only
// the .app, which the updater uses).
// Like dist-win.js it stamps this clone's folder and commit into the packaged package.json (piCrustSource,
// piCrustCommit), so the installed app knows where to look for updates (src/update-main.js).
// The app is signed ad hoc (no Apple developer account): it runs on the Mac that built it. A copy downloaded
// elsewhere gets Gatekeeper's "unidentified developer" warning.
"use strict";
const { spawnSync } = require("child_process");
const path = require("path");

if (process.platform !== "darwin") {
	console.error("Build the Mac app on a Mac: electron-builder can't build macOS apps on Windows or Linux.");
	process.exit(1);
}
const root = path.resolve(__dirname, "..");
// The app uses node-pty's prebuilt binaries (node-pty/build is left out). Its spawn-helper must be executable, which
// node-pty's install script ensures, but npm 11 may have skipped that script.
const fs = require("fs");
for (const a of ["darwin-arm64", "darwin-x64"]) {
	const helper = path.join(root, "node_modules", "node-pty", "prebuilds", a, "spawn-helper");
	if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755);
}
const git = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
const commit = git.status === 0 ? git.stdout.trim() : "";
const cli = require.resolve("electron-builder/cli.js", { paths: [root] });
const arch = process.arch === "arm64" ? "--arm64" : "--x64";
const extra = process.argv.slice(2);
const args = [cli, "--mac", ...(extra.includes("--dir") ? [] : ["dmg"]), arch, `-c.extraMetadata.piCrustSource=${root}`, ...(commit ? [`-c.extraMetadata.piCrustCommit=${commit}`] : []), ...extra];
// electron-builder needs real Node (see dist-win.js): under Electron running as Node, use the Node on PATH.
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const node = process.versions.electron ? "node" : process.execPath;
const r = spawnSync(node, args, { cwd: root, stdio: "inherit", env });
if (r.error) console.error(r.error.code === "ENOENT" ? "Node.js was not found on PATH (needed to build the app)." : r.error.message);
process.exit(r.status === null ? 1 : r.status);
