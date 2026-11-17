// Machine-local plugins (main process): loads src/local/*-main.js and lists the renderer scripts in src/local/.
// Does nothing when src/local/ is missing or empty. The folder is gitignored.
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const LOCAL_DIR = path.join(__dirname, "local");

const listLocal = () => {
	try {
		return fs.readdirSync(LOCAL_DIR).sort();
	} catch {
		return [];
	}
};

// Only real files count: a directory that happens to be called "x.js" is ignored.
const isFile = (f) => {
	try {
		return fs.statSync(path.join(LOCAL_DIR, f)).isFile();
	} catch {
		return false;
	}
};
const isMain = (f) => f.endsWith("-main.js") && isFile(f);
const isRendererScript = (f) => f.endsWith(".js") && !f.endsWith("-main.js") && !f.endsWith(".test.js") && isFile(f);

function register(ctx) {
	ctx.ipcMain.handle("local:scripts", () => listLocal().filter(isRendererScript));
	for (const f of listLocal().filter((x) => isMain(x))) {
		try {
			require(path.join(LOCAL_DIR, f)).register(ctx);
		} catch (err) {
			console.error(`[local] ${f} failed to load:`, err);
		}
	}
}

module.exports = { register, listLocal, isRendererScript };
