"use strict";
// Main side of the self-test step `viewer-tabs` (selftest only, see viewer-tabs-selftest.js). The step drives the tabs through the normal IPC
// (browser:tabs, tabCreate, tabActivate, tabClose, navigate, pick); this side only does what the renderer cannot: it starts a loopback web
// server and a throwaway project, and reports which session each tab's page really has and which view ctx.browserView returns.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const pp = require("./project-protocol");

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFUlEQVR4nGP8z8Dwn4EIwESMolGFxCsEAHkDAhFq7qtlAAAAAElFTkSuQmCC", "base64");
const PDF = "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n";

function register({ ipcMain, viewerTabs, session, setRoot, ctxView, devUrl }) {
	let server = null;
	let tmp = null;
	const stop = () => {
		if (server) { try { server.close(); } catch { /* closed */ } server = null; }
		setRoot(null);
		if (tmp) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } tmp = null; }
	};
	ipcMain.handle("viewertabs:selftest", async (_e, op) => {
		if (op === "start") {
			stop();
			tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-crust-vt-")));
			const root = path.join(tmp, "project");
			fs.mkdirSync(root, { recursive: true });
			fs.writeFileSync(path.join(root, "a.html"), "<!doctype html><title>project page</title><p>hello</p>");
			fs.writeFileSync(path.join(root, "pic.png"), PNG);
			fs.writeFileSync(path.join(root, "doc.pdf"), PDF);
			setRoot(root);
			await new Promise((resolve) => {
				server = http.createServer((_req, res) => {
					res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
					res.end("<!doctype html><title>web page</title><body style='font:20px sans-serif'><p id='x'>hello</p></body>");
				});
				server.listen(0, "127.0.0.1", resolve);
			});
			const port = server.address().port;
			return {
				port,
				devUrl,
				page: pp.toAddress(root, "a.html"),
				image: pp.toAddress(root, "pic.png"),
				pdf: pp.toAddress(root, "doc.pdf"),
				otherProject: pp.toAddress(path.join(tmp, "elsewhere"), "a.html"),
				missingKind: pp.toAddress(root, "notes.txt"),
			};
		}
		if (op === "probe") {
			const web = session.fromPartition("persist:devbrowser");
			const project = session.fromPartition(pp.PARTITION);
			const { tabs, activeId } = viewerTabs.list();
			const cv = ctxView();
			const activeView = viewerTabs.viewOf(activeId);
			return {
				ctxViewIsActive: !!cv && !!activeView && cv === activeView,
				tabs: tabs.map((t) => {
					const v = viewerTabs.viewOf(t.id);
					const wc = v && v.webContents;
					return { id: t.id, isProjectSession: !!wc && wc.session === project, isWebSession: !!wc && wc.session === web, visible: !!v && v.getVisible(), isCtxView: !!v && v === cv };
				}),
			};
		}
		if (op === "stop") {
			stop();
			return { ok: true };
		}
		return { error: "unknown op" };
	});
}

module.exports = { register };
