"use strict";
// Main side of the self-test step `viewer-tabs` (selftest only, see viewer-tabs-selftest.js). The step drives the tabs through the normal IPC
// (browser:tabs, tabCreate, tabActivate, tabClose, navigate, pick); this side only does what the renderer cannot: it starts a loopback web
// server and a throwaway project, and reports which session each tab's page really has and which view ctx.browserView returns.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const pp = require("./project-protocol");
const { nativeImage } = require("electron");

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFUlEQVR4nGP8z8Dwn4EIwESMolGFxCsEAHkDAhFq7qtlAAAAAElFTkSuQmCC", "base64");
const PDF = "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n";

function register({ ipcMain, viewerTabs, session, setRoot, ctxView, devUrl, getWin }) {
	let server = null;
	let tmp = null;
	let curRoot = null;
	const stop = () => {
		if (server) { try { server.close(); } catch { /* closed */ } server = null; }
		setRoot(null);
		if (tmp) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } tmp = null; }
	};
	// A page that paints its whole background by what its session's localStorage holds under "k": red nothing, green "project", blue "web".
	const CAP = "<!doctype html><title>cap</title><body style='margin:0'><script>var v=localStorage.getItem('k');var c=v==='project'?'#00c800':v==='web'?'#0000c8':'#c80000';document.documentElement.style.background=c;document.body.style.background=c;document.body.style.height='100vh'</script>";
	ipcMain.handle("viewertabs:selftest", async (_e, arg) => {
		const op = arg && typeof arg === "object" ? arg.op : arg;
		if (op === "start") {
			stop();
			tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-crust-vt-")));
			const root = path.join(tmp, "project");
			fs.mkdirSync(root, { recursive: true });
			fs.writeFileSync(path.join(root, "a.html"), "<!doctype html><title>project page</title><p>hello</p>");
			fs.writeFileSync(path.join(root, "long.html"), "<!doctype html><title>A very long page title that goes past twenty-four characters</title><p>long</p>");
			fs.writeFileSync(path.join(root, "pic.png"), PNG);
			fs.writeFileSync(path.join(root, "b.html"), "<!doctype html><title>second page</title><p>second</p>");
			fs.writeFileSync(path.join(root, "cap.html"), CAP);
			fs.writeFileSync(path.join(root, "pic.svg"), "<svg xmlns='http://www.w3.org/2000/svg' width='40' height='30'><rect width='40' height='30' fill='#c33'/></svg>");
			const bw = 1600, bh = 1200, buf = Buffer.alloc(bw * bh * 4);
			for (let i = 0; i < bw * bh; i++) { buf[i * 4] = i % bw < bw / 2 ? 40 : 200; buf[i * 4 + 1] = 120; buf[i * 4 + 2] = 200; buf[i * 4 + 3] = 255; }
			fs.writeFileSync(path.join(root, "big.png"), nativeImage.createFromBitmap(buf, { width: bw, height: bh }).toPNG());
			fs.writeFileSync(path.join(root, "doc.pdf"), PDF);
			setRoot(root);
			curRoot = root;
			await new Promise((resolve) => {
				server = http.createServer((req, res) => {
					res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
					if (/^\/cap/.test(req.url)) return res.end(CAP);
					res.end("<!doctype html><title>web page</title><body style='font:20px sans-serif'><p id='x'>hello</p></body>");
				});
				server.listen(0, "127.0.0.1", resolve);
			});
			const port = server.address().port;
			return {
				port,
				devUrl,
				page: pp.toAddress(root, "a.html"),
				long: pp.toAddress(root, "long.html"),
				image: pp.toAddress(root, "pic.png"),
				page2: pp.toAddress(root, "b.html"),
				capPage: pp.toAddress(root, "cap.html"),
				webCap: `http://127.0.0.1:${port}/cap`,
				svg: pp.toAddress(root, "pic.svg"),
				big: pp.toAddress(root, "big.png"),
				pdf: pp.toAddress(root, "doc.pdf"),
				otherProject: pp.toAddress(path.join(tmp, "elsewhere"), "a.html"),
				missingKind: pp.toAddress(root, "notes.txt"),
			};
		}
		if (op === "probe") {
			const web = session.fromPartition("persist:devbrowser");
			const project = session.fromPartition(pp.partitionFor(curRoot));
			const { tabs, activeId } = viewerTabs.list();
			const cv = ctxView();
			const activeView = viewerTabs.viewOf(activeId);
			return {
				ctxViewIsActive: !!cv && !!activeView && cv === activeView,
				tabs: tabs.map((t) => {
					const v = viewerTabs.viewOf(t.id);
					const wc = v && v.webContents;
					return { id: t.id, isProjectSession: !!wc && wc.session === project, isWebSession: !!wc && wc.session === web, visible: !!v && v.getVisible(), isCtxView: !!v && v === cv, debuggerAttached: !!wc && !wc.isDestroyed() && wc.debugger.isAttached() };
				}),
			};
		}
		// Run a script in one tab's page (it may be a background tab).
		if (op === "js") {
			const v = viewerTabs.viewOf(arg.tab);
			if (!v || v.webContents.isDestroyed()) return { error: "no such tab" };
			try { return { value: await v.webContents.executeJavaScript(String(arg.code), true) }; } catch (e) { return { error: String((e && e.message) || e) }; }
		}
		// The element a pick would have chosen (a real pick needs a click): becomes the target of the forced states.
		if (op === "notePick") {
			await require("./browser-tools-main").notePick({ raw: [{ selector: String(arg.selector) }] });
			return { ok: true };
		}
		if (op === "external") return { last: viewerTabs.lastExternal() };
		// The window and the active tab's page, as two images (the native view is not part of the window's own capture).
		if (op === "shot") {
			const win = getWin();
			const out = { z: win.webContents.getZoomFactor() };
			if (arg.what === "win") out.win = (await win.webContents.capturePage()).toDataURL();
			else {
				const v = ctxView();
				let img = null;
				for (let i = 0; v && i < 3 && !img; i++) { try { img = await v.webContents.capturePage(undefined, { stayHidden: true }); } catch { await new Promise((r) => setTimeout(r, 400)); } }
				out.view = img ? img.toDataURL() : null;
				out.bounds = v ? v.getBounds() : null;
			}
			return out;
		}
		if (op === "saveShot") {
			const dir = process.env.PI_CRUST_VT_SHOTDIR;
			if (!dir || !/^[\w-]+$/.test(String(arg.name))) return { ok: false };
			fs.mkdirSync(dir, { recursive: true });
			const file = path.join(dir, `${arg.name}.png`);
			fs.writeFileSync(file, nativeImage.createFromDataURL(String(arg.dataUrl)).toPNG());
			return { ok: true, file };
		}
		if (op === "stop") {
			stop();
			return { ok: true };
		}
		return { error: "unknown op" };
	});
}

module.exports = { register };
