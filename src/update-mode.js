// Which kind of install is this, and so which updater applies? One pure decision plus a thin reader.
//   clone    a git clone is the source: a dev run (npm start), or an installed app built from a clone (git updater, update-main.js)
//   release  an installer built by the release workflow (piCrustBuild: "release"): updates come from GitHub releases
//   off      nothing to update from: no card, no timers
// A release build never looks for a clone, so a team member's clone in ~/Documents cannot pull it back onto the git path.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// A Pi Crust git clone: has .git and a package.json named pi-crust.
function isClone(dir) {
	try {
		return !!dir && fs.existsSync(path.join(dir, ".git")) && JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).name === "pi-crust";
	} catch {
		return false;
	}
}

// facts: { isPackaged, platform, meta (the packaged package.json, or {}), cloneAbove (dir or null), stampedClone (piCrustSource if it is a clone, else null), documentsClone (dir or null) }
// Returns { mode, via, dir }: via is "above" | "stamped" | "documents" for clone mode.
function chooseMode(f) {
	const meta = f.meta && typeof f.meta === "object" ? f.meta : {};
	if (f.cloneAbove) return { mode: "clone", via: "above", dir: f.cloneAbove };
	const supported = f.platform === "win32" || f.platform === "darwin"; // builds for other platforms can't be redone from here
	if (!f.isPackaged || !supported) return { mode: "off", via: null, dir: null };
	if (f.stampedClone) return { mode: "clone", via: "stamped", dir: f.stampedClone };
	if (meta.piCrustBuild === "release") return { mode: f.platform === "win32" ? "release" : "off", via: null, dir: null };
	// Installed before builds were stamped: the clone is probably where SETUP.md puts it.
	if (f.documentsClone) return { mode: "clone", via: "documents", dir: f.documentsClone };
	return { mode: "off", via: null, dir: null };
}

function readMeta(appPath) {
	try {
		const m = JSON.parse(fs.readFileSync(path.join(appPath, "package.json"), "utf8"));
		return m && typeof m === "object" ? m : {};
	} catch {
		return {};
	}
}

// Reads the facts from disk, then decides. `app` needs getAppPath() and isPackaged.
function detect(app, platform = process.platform, home = os.homedir()) {
	const meta = readMeta(app.getAppPath());
	let dir;
	try {
		dir = fs.realpathSync(app.getAppPath());
	} catch {
		dir = app.getAppPath();
	}
	let cloneAbove = null;
	for (let i = 0; i < 3 && dir; i++, dir = path.dirname(dir)) {
		if (isClone(dir)) {
			cloneAbove = dir;
			break;
		}
	}
	const stampedClone = isClone(meta.piCrustSource) ? meta.piCrustSource : null;
	const documentsClone = ["Pi-Crust", "pi-crust"].map((n) => path.join(home, "Documents", n)).find(isClone) || null;
	const r = chooseMode({ isPackaged: !!app.isPackaged, platform, meta, cloneAbove, stampedClone, documentsClone });
	return { ...r, commit: r.mode === "clone" && r.via !== "above" && r.via !== "documents" ? meta.piCrustCommit || null : null };
}

module.exports = { chooseMode, detect, isClone };
