#!/usr/bin/env node
// Builds two throwaway, UNSIGNED Windows installers of a fake app (0.0.1 and 0.0.2) for update tests:
// `node scripts/make-test-builds.js <work folder> [port]`. The fake app has its own appId and product name, so it
// can never touch a real Pi Crust install. It never runs an installer. Output:
//   <work>/app-0.0.1, <work>/app-0.0.2   unpackaged app folders (run them with Electron to act as the "installed" version)
//   <work>/feed                          latest.yml, both installers and their .blockmap files (serve with update-feed-server.js)
"use strict";
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const work = path.resolve(process.argv[2] || "");
const port = Number(process.argv[3] || 8099);
if (!process.argv[2]) {
	console.error("usage: node scripts/make-test-builds.js <work folder> [port]");
	process.exit(2);
}
const cli = require.resolve("electron-builder/cli.js", { paths: [root] });
const electronDist = path.join(root, "node_modules", "electron", "dist");
const electronVersion = require(path.join(root, "node_modules", "electron", "package.json")).version;
const feed = path.join(work, "feed");
fs.mkdirSync(feed, { recursive: true });

for (const version of ["0.0.1", "0.0.2"]) {
	const app = path.join(work, `app-${version}`);
	fs.rmSync(app, { recursive: true, force: true });
	fs.mkdirSync(path.join(app, "src"), { recursive: true });
	fs.writeFileSync(path.join(app, "package.json"), JSON.stringify({ name: "pi-crust-updatetest", version, main: "src/main.js", author: "Nullvorm", description: "Update test app" }, null, 2));
	fs.writeFileSync(path.join(app, "src", "main.js"), "// fake app: only the spike runner starts it\nrequire('electron').app.quit();\n");
	fs.writeFileSync(
		path.join(app, "electron-builder.json"),
		JSON.stringify(
			{
				appId: "dev.pidieks.picrust.updatetest",
				productName: "Pi Crust UpdateTest",
				asar: false,
				npmRebuild: false,
				electronDist,
				electronVersion,
				directories: { output: "dist" },
				files: ["package.json", "src/**/*"],
				win: { target: [{ target: "nsis", arch: ["x64"] }], artifactName: "Pi-Crust-UpdateTest-Setup-${version}.${ext}", signAndEditExecutable: false, forceCodeSigning: false },
				nsis: { oneClick: false, perMachine: false, allowElevation: false, allowToChangeInstallationDirectory: false, shortcutName: "Pi Crust UpdateTest" },
				publish: [{ provider: "generic", url: `http://127.0.0.1:${port}/` }],
			},
			null,
			2
		)
	);
	const env = { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false" };
	delete env.ELECTRON_RUN_AS_NODE;
	const r = spawnSync("node", [cli, "--win", "nsis", "--x64", "--projectDir", app, "--config", "electron-builder.json", "--publish", "never"], { cwd: app, stdio: "inherit", env, windowsHide: true });
	if (r.status !== 0) process.exit(r.status || 1);
	for (const f of fs.readdirSync(path.join(app, "dist"))) {
		if (/\.(exe|blockmap)$/.test(f) && !/uninstaller/i.test(f)) fs.copyFileSync(path.join(app, "dist", f), path.join(feed, f));
		if (f === "latest.yml" && version === "0.0.2") fs.copyFileSync(path.join(app, "dist", f), path.join(feed, f));
	}
	if (version === "0.0.1") fs.copyFileSync(path.join(app, "dist", "latest.yml"), path.join(work, "latest-0.0.1.yml"));
}
console.log("[make-test-builds] done:", fs.readdirSync(feed).join(", "));
