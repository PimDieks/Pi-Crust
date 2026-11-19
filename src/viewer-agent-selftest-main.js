"use strict";
// Main side of the self-test step `viewer-agent` (selftest only, see viewer-agent-selftest.js). The project is the run's throwaway git repo (the
// runner scripts/viewer-agent-selftest.js made it with the files and the folder outside it). This starts a loopback web page, tells the step which
// of the tabs' native views are visible, and saves the screenshots (window captures, PI_CRUST_VA_SHOTDIR, prefix va-).
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { nativeImage } = require("electron");

function register({ ipcMain, viewerTabs, getWin, getRoot, breakMode }) {
	let server = null;
	ipcMain.handle("vieweragent:selftest", async (_e, arg) => {
		const op = arg && typeof arg === "object" ? arg.op : arg;
		if (op === "start") {
			if (server) { try { server.close(); } catch { /* closed */ } server = null; }
			await new Promise((resolve) => {
				server = http.createServer((_req, res) => {
					res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
					res.end('<!doctype html><meta charset="utf-8"><title>Dev server</title><body style="font:20px sans-serif;margin:24px"><h1>Dev server</h1><p>A page on localhost.</p></body>');
				});
				server.listen(0, "127.0.0.1", resolve);
			});
			return { root: getRoot(), port: server.address().port, outside: process.env.PI_CRUST_VA_OUTSIDE || "", brk: breakMode, sep: path.sep };
		}
		// Which tab's native view is visible right now: only the active one may be, and none while another app tab is in front.
		if (op === "visible") {
			const l = viewerTabs.list();
			return { visible: l.tabs.filter((t) => { const v = viewerTabs.viewOf(t.id); return v && v.getVisible(); }).map((t) => t.id), activeId: l.activeId };
		}
		if (op === "shot") {
			const dir = process.env.PI_CRUST_VA_SHOTDIR;
			if (!dir || !/^[\w-]+$/.test(String(arg.name))) return { ok: false };
			fs.mkdirSync(dir, { recursive: true });
			const win = getWin();
			const img = await win.webContents.capturePage();
			if (!img) return { ok: false };
			fs.writeFileSync(path.join(dir, `${arg.name}.png`), nativeImage.createFromDataURL(img.toDataURL()).toPNG());
			return { ok: true };
		}
		if (op === "stop") {
			if (server) { try { server.close(); } catch { /* closed */ } server = null; }
			return { ok: true };
		}
		return { error: "unknown op" };
	});
}

module.exports = { register };
