"use strict";
// Main side of the self-test step `viewer-open` (selftest only, see viewer-open-selftest.js). It builds the throwaway projects and the folder
// outside them, replaces the project root the Viewer sees (as the viewer-tabs step does), starts a loopback web server and saves the
// screenshots. Everything under test (the bar, the suggestions, the tree menu, the Editor button, the drop) is driven through the real UI and
// the real IPC by the renderer side.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawnSync } = require("node:child_process");
const { nativeImage } = require("electron");
const pp = require("./project-protocol");

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFUlEQVR4nGP8z8Dwn4EIwESMolGFxCsEAHkDAhFq7qtlAAAAAElFTkSuQmCC", "base64");
const PDF = "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n";
const page = (title, body = "") => `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:20px sans-serif;margin:24px"><h1>${title}</h1>${body}</body>`;

function register({ ipcMain, viewerTabs, setRoot, getWin, ctxView, breakMode }) {
	let tmp = null;
	let server = null;
	const open = (root) => {
		viewerTabs.projectWillChange();
		setRoot(root);
		viewerTabs.projectChanged();
	};
	const stop = () => {
		if (server) { try { server.close(); } catch { /* closed */ } server = null; }
		open(null);
		if (tmp) {
			try { fs.rmdirSync(path.join(tmp, "project", "linkdir")); } catch { /* none */ } // the link first: nothing may follow it into the folder it points at
			try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort: the link is gone already */ }
			tmp = null;
		}
	};
	const put = (base, rel, data) => {
		fs.mkdirSync(path.dirname(path.join(base, rel)), { recursive: true });
		fs.writeFileSync(path.join(base, rel), data);
	};
	// The files both projects hold. `ignored/` is listed in .gitignore: git knows it, a plain walk does not.
	const fill = (root) => {
		put(root, "index.html", page("Home"));
		put(root, "docs/pricing.html", page("Pricing", "<p>Plans and prices</p>"));
		put(root, "docs/about-us.html", page("About us"));
		put(root, "docs/guide/start.html", page("Getting started"));
		put(root, "docs/My Page.html", page("My Page"));
		put(root, "img/logo.svg", "<svg xmlns='http://www.w3.org/2000/svg' width='120' height='80'><rect width='120' height='80' fill='#3b82c4'/><circle cx='60' cy='40' r='24' fill='#fff'/></svg>");
		put(root, "img/photo.png", PNG);
		put(root, "brochure.pdf", PDF);
		put(root, "notes.txt", "notes");
		put(root, "src/app.js", "// app");
		put(root, "src/app-mark.svg", "<svg xmlns='http://www.w3.org/2000/svg' width='40' height='40'><rect width='40' height='40' fill='#c33'/></svg>");
		put(root, "package.json", "{}");
		put(root, ".hidden/secret.html", page("Secret"));
		put(root, ".env", "KEY=1");
		put(root, "node_modules/pkg/readme.html", page("Readme"));
		put(root, "ignored/skip.html", page("Ignored"));
		put(root, ".gitignore", "ignored/\n");
		for (let i = 1; i <= 12; i++) put(root, `many/page${String(i).padStart(2, "0")}.html`, page(`Page ${i}`));
	};
	let outsideFile = "";
	ipcMain.handle("vieweropen:selftest", async (_e, arg) => {
		const op = arg && typeof arg === "object" ? arg.op : arg;
		if (op === "start") {
			stop();
			tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-crust-vo-")));
			const root = path.join(tmp, "project");
			const plain = path.join(tmp, "plain");
			const outside = path.join(tmp, "outside");
			for (const r of [root, plain]) fill(r);
			put(outside, "secret.html", page("Outside"));
			put(outside, "secret.png", PNG);
			outsideFile = path.join(outside, "secret.html");
			// A link that points outside: a junction (a directory link that needs no privilege on Windows), a symlink elsewhere.
			let link = false;
			try { fs.symlinkSync(outside, path.join(root, "linkdir"), process.platform === "win32" ? "junction" : "dir"); link = true; } catch { /* no link on this machine */ }
			// A git project: git knows what is ignored.
			const git = spawnSync("git", ["init", "-q"], { cwd: root, windowsHide: true });
			const gitOk = git.status === 0;
			if (gitOk) spawnSync("git", ["add", "-A"], { cwd: root, windowsHide: true });
			await new Promise((resolve) => {
				server = http.createServer((_req, res) => {
					res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
					res.end(page("Web page"));
				});
				server.listen(0, "127.0.0.1", resolve);
			});
			open(root);
			return {
				root,
				plain,
				outside,
				outsideFile,
				link,
				gitOk,
				port: server.address().port,
				sep: path.sep,
				brk: breakMode,
			};
		}
		if (op === "root") {
			open(arg.which === "plain" ? path.join(tmp, "plain") : path.join(tmp, "project"));
			return { ok: true };
		}
		if (op === "address") return { address: pp.toAddress(arg.root, arg.rel) };
		if (op === "shot") {
			const dir = process.env.PI_CRUST_VO_SHOTDIR;
			if (!dir || !/^[\w-]+$/.test(String(arg.name))) return { ok: false };
			fs.mkdirSync(dir, { recursive: true });
			const file = path.join(dir, `${arg.name}.png`);
			const win = getWin();
			let img;
			if (arg.what === "view") {
				const v = ctxView();
				for (let i = 0; v && i < 3 && !img; i++) { try { img = await v.webContents.capturePage(undefined, { stayHidden: true }); } catch { await new Promise((r) => setTimeout(r, 400)); } }
			} else img = await win.webContents.capturePage();
			if (!img) return { ok: false };
			fs.writeFileSync(file, nativeImage.createFromDataURL(img.toDataURL()).toPNG());
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
