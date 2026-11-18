#!/usr/bin/env node
// Update spike: `node scripts/update-spike.js <work folder> <scenario> [port]`. Proves electron-updater's check, download and
// signature verification against a local feed. It NEVER installs: the installer is only downloaded, autoInstallOnAppQuit is off,
// and quitAndInstall is never called. The install step is NOT covered by this script.
// Scenarios: ok | publisher | differential | offline | corrupt | uptodate
// Everything runs under a temp APPDATA/LOCALAPPDATA inside <work>/run-<scenario>, so no real Pi Crust folder is touched.
// Needs <work> from scripts/make-test-builds.js. Run as a plain Node script (launcher) or, internally, inside Electron (runner).
"use strict";
const path = require("path");
const fs = require("fs");

if (process.versions.electron) runner();
else launcher();

function launcher() {
	const { spawn } = require("child_process");
	const work = path.resolve(process.argv[2] || "");
	const scenario = process.argv[3];
	const port = Number(process.argv[4] || 8099);
	if (!process.argv[2] || !["ok", "publisher", "differential", "offline", "corrupt", "uptodate"].includes(scenario)) {
		console.error("usage: node scripts/update-spike.js <work folder> <ok|publisher|differential|offline|corrupt|uptodate> [port]");
		process.exit(2);
	}
	const run = path.join(work, `run-${scenario}`);
	fs.rmSync(run, { recursive: true, force: true });
	const appdata = path.join(run, "AppData", "Roaming");
	const local = path.join(run, "AppData", "Local");
	const appDir = path.join(run, "app");
	for (const d of [appdata, local, appDir]) fs.mkdirSync(d, { recursive: true });
	const version = scenario === "uptodate" ? "0.0.2" : "0.0.1";
	fs.writeFileSync(path.join(appDir, "package.json"), JSON.stringify({ name: "pi-crust-updatetest", version, main: "main.js" }));
	fs.writeFileSync(path.join(appDir, "main.js"), `require(${JSON.stringify(__filename)});\n`);
	const yml = ["provider: generic", `url: http://127.0.0.1:${port}/`, "updaterCacheDirName: pi-crust-updatetest-updater"];
	if (scenario === "publisher") yml.push("publisherName: Nullvorm");
	fs.writeFileSync(path.join(appDir, "dev-app-update.yml"), yml.join("\n") + "\n");
	const cache = path.join(local, "pi-crust-updatetest-updater");

	let feed = path.join(work, "feed");
	if (scenario === "corrupt") {
		feed = path.join(run, "feed-corrupt");
		fs.mkdirSync(feed);
		for (const f of fs.readdirSync(path.join(work, "feed"))) {
			if (f.endsWith("0.0.2.exe")) continue;
			fs.copyFileSync(path.join(work, "feed", f), path.join(feed, f));
		}
		const buf = fs.readFileSync(path.join(work, "feed", "Pi-Crust-UpdateTest-Setup-0.0.2.exe"));
		buf[buf.length - 1000] ^= 0xff; // same size, different content: latest.yml's sha512 no longer matches
		fs.writeFileSync(path.join(feed, "Pi-Crust-UpdateTest-Setup-0.0.2.exe"), buf);
	}
	if (scenario === "differential") {
		fs.mkdirSync(cache, { recursive: true });
		fs.copyFileSync(path.join(work, "feed", "Pi-Crust-UpdateTest-Setup-0.0.1.exe"), path.join(cache, "installer.exe"));
	}

	let server = null;
	const bytes = { full: 0, range: 0, requests: [] };
	const finish = (code) => {
		if (server) server.kill();
		console.log(`[spike] feed requests: ${bytes.requests.length}; whole-installer downloads ${bytes.full}; range bytes served ${bytes.range}`);
		for (const r of bytes.requests) console.log("[spike]   " + r);
		console.log("[spike] cache folder listing:");
		listDir(local, local);
		process.exit(code);
	};
	const startRunner = () => {
		const electron = require(path.join(__dirname, "..", "node_modules", "electron"));
		const env = { ...process.env, APPDATA: appdata, LOCALAPPDATA: local, SPIKE_SCENARIO: scenario };
		delete env.ELECTRON_RUN_AS_NODE;
		const child = spawn(electron, [appDir], { env, stdio: "inherit", windowsHide: true });
		const timer = setTimeout(() => child.kill(), 180000);
		child.on("close", (status) => {
			clearTimeout(timer);
			setTimeout(() => finish(status === 0 ? 0 : 1), 300); // let the last feed log lines arrive
		});
	};
	if (scenario === "offline") return startRunner();
	server = spawn("node", [path.join(__dirname, "update-feed-server.js"), feed, String(port)], { stdio: ["ignore", "pipe", "inherit"], windowsHide: true });
	server.stdout.on("data", (d) => {
		for (const line of String(d).split(/\r?\n/).filter(Boolean)) {
			if (/^\[feed\] serving/.test(line)) {
				console.log(line);
				if (!startRunner.started) {
					startRunner.started = true;
					setImmediate(startRunner);
				}
				continue;
			}
			bytes.requests.push(line);
			let m = /-> 206 (\d+)-(\d+)/.exec(line);
			if (m) bytes.range += Number(m[2]) - Number(m[1]) + 1;
			else if ((m = /-> 206 multi \d+ ranges, (\d+) bytes/.exec(line))) bytes.range += Number(m[1]);
			else if (/-> 200 full/.test(line) && /\.exe \->/.test(line)) bytes.full += 1; // a whole installer served
		}
	});
}

function listDir(dir, base) {
	if (!fs.existsSync(dir)) return;
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) listDir(p, base);
		else console.log(`[spike]   ${path.relative(base, p)} (${fs.statSync(p).size} bytes)`);
	}
}

function runner() {
	const { app } = require("electron");
	const { autoUpdater } = require(path.join(__dirname, "..", "node_modules", "electron-updater"));
	const scenario = process.env.SPIKE_SCENARIO;
	const say = (...a) => console.log("[spike]", ...a);
	app.whenReady().then(async () => {
		let code = 0;
		try {
			autoUpdater.forceDevUpdateConfig = true;
			autoUpdater.autoDownload = false;
			autoUpdater.autoInstallOnAppQuit = false; // never install, not even on quit
			autoUpdater.allowPrerelease = false;
			autoUpdater.allowDowngrade = false;
			autoUpdater.logger = { info: (m) => say("log:", m), warn: (m) => say("warn:", m), error: (m) => say("error:", m), debug: () => {} };
			let lastPct = -1;
			autoUpdater.on("download-progress", (p) => {
				const pct = Math.floor(p.percent / 25) * 25;
				if (pct !== lastPct) say(`progress ${p.percent.toFixed(0)}% (${p.transferred}/${p.total}, ${p.bytesPerSecond} B/s)`);
				lastPct = pct;
			});
			autoUpdater.on("update-downloaded", (i) => say("event update-downloaded", i.version, i.downloadedFile));
			say(`scenario=${scenario} app version=${app.getVersion()} isPackaged=${app.isPackaged} cachePath=${app.getPath("userData") && process.env.LOCALAPPDATA}`);
			const r = await autoUpdater.checkForUpdates();
			say(`check result: updateInfo.version=${r && r.updateInfo.version} isUpdateAvailable=${r && r.isUpdateAvailable}`);
			if (r && r.isUpdateAvailable) {
				const t0 = Date.now();
				const files = await autoUpdater.downloadUpdate();
				say(`DOWNLOAD+VERIFY OK in ${Date.now() - t0} ms: ${files.join(", ")}`);
				for (const f of files) say(`file size ${fs.statSync(f).size}`);
			}
		} catch (e) {
			code = 0; // an expected failure in several scenarios; the log says which
			say(`FAILED: code=${e && e.code} message=${String(e && e.message).split("\n")[0]}`);
		}
		app.exit(code);
	});
}
