"use strict";
// Main side of the self-test step `viewer-reload` (selftest only, see viewer-reload-selftest.js). It builds a throwaway project, replaces the
// project root the Viewer sees (as the viewer-open step does), starts two loopback web servers that count their hits, changes, deletes and
// renames project files on request (what an editor or a build does), and reads the watch state and the active page for the checks. Everything
// under test (tabs, pages, the address handler, the watchers) is the real thing.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const pp = require("./project-protocol");

// A page that shows how often it loaded in this tab (sessionStorage survives a reload), what its stylesheet and script did, and its name:
// title "<name>:<loads>|<body background>|<script value>".
const page = (name, { css = true, js = true, img = true } = {}) =>
	`<!doctype html><meta charset="utf-8"><title>${name}</title>` +
	(css ? '<link rel="stylesheet" href="style.css">' : "<style>body{background:rgb(1,2,3)}</style>") +
	(js ? '<script src="app.js" defer></script>' : "") +
	`<body><h1>${name}</h1>${img ? '<img src="pic.png" width="4" height="4" alt="">' : ""}<div style="height:5000px">tall</div>` +
	`<script>var n=1;try{n=(+sessionStorage.getItem("n")||0)+1;sessionStorage.setItem("n",n)}catch(e){}
addEventListener("load",function(){document.title=${JSON.stringify(name)}+":"+n+"|"+getComputedStyle(document.body).backgroundColor+"|"+(window.__v||"-")})</script>`;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFUlEQVR4nGP8z8Dwn4EIwESMolGFxCsEAHkDAhFq7qtlAAAAAElFTkSuQmCC", "base64");

function register({ ipcMain, viewerTabs, setRoot, getWin, breakMode }) {
	let tmp = null;
	const servers = [];
	const hits = { A: 0, B: 0 };
	const open = (root) => {
		viewerTabs.projectWillChange();
		setRoot(root);
		viewerTabs.projectChanged();
	};
	const stop = () => {
		for (const s of servers.splice(0)) { try { s.close(); } catch { /* closed */ } }
		open(null);
		if (tmp) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } tmp = null; }
	};
	const put = (rel, data) => {
		const f = path.join(tmp, "project", rel);
		fs.mkdirSync(path.dirname(f), { recursive: true });
		fs.writeFileSync(f, data);
	};
	const listen = (key) =>
		new Promise((resolve) => {
			const s = http.createServer((_req, res) => {
				hits[key]++;
				res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
				res.end(`<!doctype html><title>web ${key}</title><p>web ${key}</p>`);
			});
			servers.push(s);
			s.listen(0, "127.0.0.1", () => resolve(s.address().port));
		});
	ipcMain.handle("viewerreload:selftest", async (_e, arg) => {
		const op = arg && typeof arg === "object" ? arg.op : arg;
		if (op === "start") {
			stop();
			tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-crust-vr-")));
			put("page.html", page("page"));
			put("page2.html", page("page2"));
			put("other.html", page("other", { css: false, js: false, img: false }));
			put("del.html", page("del", { css: false, js: false, img: false }));
			put("style.css", "body{background:rgb(10,20,30)}");
			put("app.js", "window.__v='v1'");
			put("pic.png", PNG);
			put("plain/index.html", page("plain", { css: false, js: false, img: false }));
			fs.mkdirSync(path.join(tmp, "project2"));
			fs.writeFileSync(path.join(tmp, "project2", "index.html"), page("p2", { css: false, js: false, img: false }));
			const portA = await listen("A");
			const portB = await listen("B");
			const root = path.join(tmp, "project");
			open(root);
			return { root, root2: path.join(tmp, "project2"), portA, portB, brk: breakMode };
		}
		if (op === "address") return { address: pp.toAddress(arg.root, arg.rel) };
		if (op === "write") { put(arg.rel, arg.data); return { ok: true }; }
		if (op === "del") { fs.rmSync(path.join(tmp, "project", arg.rel), { force: true }); return { ok: true }; }
		if (op === "rename") { fs.renameSync(path.join(tmp, "project", arg.from), path.join(tmp, "project", arg.to)); return { ok: true }; }
		// What a build does: many files at once in one folder (and optionally one more write of a watched file in the middle).
		if (op === "storm") {
			for (let i = 0; i < (arg.n || 300); i++) {
				put(`${arg.dir || "dist"}/chunk-${i}.js`, "x".repeat(i % 7));
				if (arg.touch && i === Math.floor((arg.n || 300) / 2)) put(arg.touch, arg.data);
			}
			return { ok: true };
		}
		if (op === "stats") return { ...viewerTabs.reloadStats(), hits: { ...hits } };
		if (op === "root") { open(arg.which === 2 ? path.join(tmp, "project2") : path.join(tmp, "project")); return { ok: true }; }
		// The active page: run a short script in it (selftest only), and ask whether it holds keyboard focus.
		if (op === "eval") {
			const wc = viewerTabs.activeWc();
			return { value: wc ? await wc.executeJavaScript(String(arg.code), true).catch((e) => "ERR " + e.message) : null };
		}
		if (op === "viewFocused") { const wc = viewerTabs.activeWc(); return { focused: !!wc && wc.isFocused(), winFocused: !!getWin()?.isFocused() }; }
		if (op === "stop") { stop(); return { ok: true }; }
		return { error: "unknown op" };
	});
}

module.exports = { register };
