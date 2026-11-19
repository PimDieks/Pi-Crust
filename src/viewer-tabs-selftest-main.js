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

// PI_CRUST_VT_PHASE ("save" or "restore") with PI_CRUST_VT_PROJECT (a project folder that outlives the run) are set by
// scripts/viewer-tabs-restart.js, which launches the app twice with the same data folder: the step then runs only its restart checks.
const PHASE = process.env.PI_CRUST_VT_PHASE || "";
const FIXED_PROJECT = process.env.PI_CRUST_VT_PROJECT || "";

function register({ ipcMain, viewerTabs, session, setRoot, ctxView, devUrl, getWin, userData }) {
	let server = null;
	let tmp = null;
	let curRoot = null;
	// What opening a project does in the app (main.js openRepo): the old project's tabs are saved and closed, the new one's come back.
	// The selftest cannot move the app's real project (that would restart Pi), so it replaces the project root the Viewer sees.
	const open = (root) => {
		viewerTabs.projectWillChange();
		setRoot(root);
		curRoot = root || curRoot;
		viewerTabs.projectChanged();
	};
	const stop = () => {
		if (server) { try { server.close(); } catch { /* closed */ } server = null; }
		if (!PHASE) open(null); // a restart run keeps the project open: the app's own quit saves its tabs under its key
		if (tmp) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } tmp = null; }
	};
	const curRootFixed = () => (FIXED_PROJECT ? fs.realpathSync(FIXED_PROJECT) : "");
	const makeProject = (root, fixed) => {
		fs.mkdirSync(root, { recursive: true });
		if (fixed && PHASE === "restore" && root === curRootFixed()) return; // launch 2 finds the project as launch 1 and the runner left it (one file gone)
		const put = (name, data) => { if (!fixed || !fs.existsSync(path.join(root, name))) fs.writeFileSync(path.join(root, name), data); };
		put("a.html", "<!doctype html><title>project page</title><p>hello</p>");
		put("long.html", "<!doctype html><title>A very long page title that goes past twenty-four characters</title><p>long</p>");
		put("pic.png", PNG);
		put("b.html", "<!doctype html><title>second page</title><p>second</p>");
		put("cap.html", CAP);
		put("pic.svg", "<svg xmlns='http://www.w3.org/2000/svg' width='40' height='30'><rect width='40' height='30' fill='#c33'/></svg>");
		put("doc.pdf", PDF);
		put("gone.html", "<!doctype html><title>soon gone</title><p>gone</p>");
	};
	// A page that paints its whole background by what its session's localStorage holds under "k": red nothing, green "project", blue "web".
	const CAP = "<!doctype html><title>cap</title><body style='margin:0'><script>var v=localStorage.getItem('k');var c=v==='project'?'#00c800':v==='web'?'#0000c8':'#c80000';document.documentElement.style.background=c;document.body.style.background=c;document.body.style.height='100vh'</script>";
	ipcMain.handle("viewertabs:selftest", async (_e, arg) => {
		const op = arg && typeof arg === "object" ? arg.op : arg;
		if (op === "start") {
			stop();
			tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-crust-vt-")));
			const root = FIXED_PROJECT ? fs.realpathSync(FIXED_PROJECT) : path.join(tmp, "project");
			makeProject(root, !!FIXED_PROJECT);
			const bw = 1600, bh = 1200, buf = Buffer.alloc(bw * bh * 4);
			for (let i = 0; i < bw * bh; i++) { buf[i * 4] = i % bw < bw / 2 ? 40 : 200; buf[i * 4 + 1] = 120; buf[i * 4 + 2] = 200; buf[i * 4 + 3] = 255; }
			fs.writeFileSync(path.join(root, "big.png"), nativeImage.createFromBitmap(buf, { width: bw, height: bh }).toPNG());
			open(root);
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
				phase: PHASE,
				root,
				tmp,
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
					return { id: t.id, hasView: !!v, wcUrl: wc && !wc.isDestroyed() ? wc.getURL() : "", isProjectSession: !!wc && wc.session === project, isWebSession: !!wc && wc.session === web, visible: !!v && v.getVisible(), isCtxView: !!v && v === cv, debuggerAttached: !!wc && !wc.isDestroyed() && wc.debugger.isAttached() };
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
		// Remembered tabs: the stored value of a project (by the same key the app uses), and a project switch (as openRepo does it).
		if (op === "stored") {
			try {
				const all = JSON.parse(fs.readFileSync(path.join(userData(), "settings.json"), "utf8")).viewerTabs || {};
				const key = require("./figma-main").repoKey(arg.root);
				return { all, entry: all[key] === undefined ? null : all[key], key, file: fs.readFileSync(path.join(userData(), "settings.json"), "utf8") };
			} catch (e) { return { all: {}, entry: null, error: String((e && e.message) || e) }; }
		}
		if (op === "flush") { viewerTabs.flush(); return { ok: true }; }
		if (op === "project") {
			if (arg.make) fs.mkdirSync(arg.root, { recursive: true });
			const root = fs.realpathSync(arg.root);
			if (arg.make) makeProject(root, true);
			open(root);
			return { ok: true, root, page: pp.toAddress(root, "a.html"), image: pp.toAddress(root, "pic.png"), page2: pp.toAddress(root, "b.html"), pdf: pp.toAddress(root, "doc.pdf"), gone: pp.toAddress(root, "gone.html") };
		}
		// A late request from a page of the project that was open: the address handler (project-protocol serve, which every request goes
		// through) answers 404 for another project's host; and a real request on that project's own session is never served either.
		if (op === "lateFetch") {
			const address = pp.toAddress(arg.root, arg.file);
			const out = { serve: pp.serve({ method: "GET", url: address, headers: new Headers() }, curRoot).status };
			try { out.fetch = (await session.fromPartition(pp.partitionFor(arg.root)).fetch(address)).status; } catch (e) { out.fetch = "refused: " + String((e && e.message) || e).slice(0, 80); }
			return out;
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
