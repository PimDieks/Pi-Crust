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

const isMain = (f) => f.endsWith("-main.js");
const isRendererScript = (f) => f.endsWith(".js") && !isMain(f) && !f.endsWith(".test.js");

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
