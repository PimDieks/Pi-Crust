#!/usr/bin/env node
// `npm run dist:win`: builds dist\Pi Crust Setup <version>.exe with electron-builder.
// Stamps this clone's folder and commit into the packaged package.json (piCrustSource, piCrustCommit), so the
// installed app knows where to look for updates and which commit it was built from (src/update-main.js).
"use strict";
const { spawnSync } = require("child_process");
const path = require("path");

const root = path.resolve(__dirname, "..");
const git = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", windowsHide: true });
const commit = git.status === 0 ? git.stdout.trim() : "";
const cli = require.resolve("electron-builder/cli.js", { paths: [root] });
const args = [cli, "--win", "nsis", "--x64", `-c.extraMetadata.piCrustSource=${root}`, ...(commit ? [`-c.extraMetadata.piCrustCommit=${commit}`] : []), ...process.argv.slice(2)];
// electron-builder needs real Node: under Electron running as Node (the in-app updater) its argument parser sees
// Electron, skips one argument too few and fails with "Unknown argument: ...cli.js". Use the Node on PATH then.
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const node = process.versions.electron ? "node" : process.execPath;
const r = spawnSync(node, args, { cwd: root, stdio: "inherit", env, windowsHide: true });
if (r.error) console.error(r.error.code === "ENOENT" ? "Node.js was not found on PATH (needed to build the installer)." : r.error.message);
process.exit(r.status === null ? 1 : r.status);
