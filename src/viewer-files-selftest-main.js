"use strict";
// Main side of the self-test step `viewer-files` (selftest only, see viewer-files-selftest.js): the pi-project:// address on hidden test
// windows on the project session. It never touches the Viewer. A throwaway project folder stands in for the open project, a loopback
// HTTP server started here stands in for a web site. Answer: { checks: [{ name, ok, detail }] }.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const pp = require("./project-protocol");
const pf = require("./project-files");

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFUlEQVR4nGP8z8Dwn4EIwESMolGFxCsEAHkDAhFq7qtlAAAAAElFTkSuQmCC", "base64");
const PDF = "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function register({ ipcMain, BrowserWindow, session, setRoot }) {
	ipcMain.handle("viewerfiles:selftest", async () => {
		const checks = [];
		const check = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: ok ? "" : String(detail === undefined ? "" : detail).slice(0, 300) });
		const wins = [];
		let server;
		let tmp;
		try {
			tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-crust-vf-")));
			const root = path.join(tmp, "project");
			const other = path.join(tmp, "other");
			const outside = path.join(tmp, "outside");
			for (const d of [root, other, outside, path.join(root, "site"), path.join(root, ".hidden"), path.join(root, ".git"), path.join(other, "site")]) fs.mkdirSync(d, { recursive: true });
			const put = (rel, data) => fs.writeFileSync(path.join(root, rel), data);
			const fontSrc = path.join(__dirname, "..", "node_modules", "katex", "dist", "fonts", "KaTeX_AMS-Regular.woff2");
			if (fs.existsSync(fontSrc)) fs.copyFileSync(fontSrc, path.join(root, "site", "font.woff2"));
			put("site/pic.png", PNG);
			put("site/doc.pdf", PDF);
			put("site/range.txt", "0123456789".repeat(10));
			put("site/style.css", "@font-face{font-family:TestFont;src:url('font.woff2') format('woff2')}\n#rel{color:rgb(1,2,3)}");
			put("site/root.css", "#abs{color:rgb(4,5,6)}");
			put("site/app.js", "window.__rel=1");
			put("site/root.js", "window.__abs=1");
			put("site/secret.js", "window.__secret=1");
			put("site/evil.svg", '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><script>document.title="svg-script-ran"</script><rect width="40" height="40" fill="red"/></svg>');
			put("site/change.js", "window.__v=1");
			put("site/change.html", '<!doctype html><title>c</title><script src="change.js"></script>');
			put("site/index.html", '<!doctype html><title>idx</title><link rel="stylesheet" href="style.css"><link rel="stylesheet" href="/site/root.css">' +
				'<p id="rel">a</p><p id="abs">b</p><img id="img" src="pic.png"><script src="app.js"></script><script src="/site/root.js"></script>');
			put(".hidden/x.txt", "hidden");
			put(".git/config", "gitconfig");
			fs.writeFileSync(path.join(outside, "secret.txt"), "OUTSIDE-SECRET");
			fs.writeFileSync(path.join(tmp, "outside.txt"), "OUTSIDE-SECRET");
			try { fs.symlinkSync(outside, path.join(root, "link"), "junction"); } catch (e) { check("setup: junction", false, e.message); }
			fs.writeFileSync(path.join(other, "site", "secret.js"), "window.__other=1");
			const host = pf.hostFor(root);
			const otherHost = pf.hostFor(other);
			const base = `${pp.SCHEME}://${host}`;
			setRoot(root);

			// --- the loopback server: a web site ---------------------------------------------------------------------------
			const reports = [];
			const seenCookies = [];
			let port = 0;
			const srv = http.createServer((req, res) => {
				const u = new URL(req.url, "http://x");
				if (req.headers.cookie) seenCookies.push(u.pathname + " " + req.headers.cookie);
				const send = (type, body) => (res.writeHead(200, { "Content-Type": type, "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" }), res.end(body));
				if (u.pathname === "/report") { reports.push(Object.fromEntries(u.searchParams)); return send("text/plain", "ok"); }
				if (u.pathname === "/ext.js") return send("text/javascript", "window.__ext=1");
				if (u.pathname === "/ext.json") return send("application/json", '{"ext":1}');
				if (u.pathname === "/ls-set.html") return send("text/html", "<script>localStorage.setItem('dev','devbrowser-value');document.title='set'</script>");
				if (u.pathname === "/ls-get.html") return send("text/html", "<script>document.title=String(localStorage.getItem('dev'))+'|'+document.cookie</script>");
				if (u.pathname === "/probe.html") return send("text/html", `<script>fetch('/report?probe=1&ls='+encodeURIComponent(String(localStorage.getItem('dev')))+'&cookie='+encodeURIComponent(document.cookie))</script>`);
				if (u.pathname === "/frame.html") {
					// A web page that tries to read the project: as script, image, fetch, stylesheet and as a nested frame.
					return send("text/html", `<!doctype html><script>
const B=${JSON.stringify(base)};const out={};let n=0;const done=()=>{if(++n===4)fetch('/report?'+new URLSearchParams({frame:'1',...out}))};
const s=document.createElement('script');s.src=B+'/site/secret.js';s.onload=()=>{out.script='loaded';done()};s.onerror=()=>{out.script='blocked';done()};document.head.append(s);
const i=new Image();i.onload=()=>{out.img='loaded';done()};i.onerror=()=>{out.img='blocked';done()};i.src=B+'/site/pic.png';
fetch(B+'/site/range.txt',{mode:'no-cors'}).then(r=>{out.fetch='loaded';done()},()=>{out.fetch='blocked';done()});
const l=document.createElement('link');l.rel='stylesheet';l.href=B+'/site/style.css';l.onload=()=>{out.css='loaded';done()};l.onerror=()=>{out.css='blocked';done()};document.head.append(l);
const f=document.createElement('iframe');f.src=B+'/site/inner.html';document.documentElement.append(f);
</script>`);
				}
				res.writeHead(404); res.end();
			});
			await new Promise((r) => srv.listen(0, "127.0.0.1", r));
			server = srv;
			port = srv.address().port;
			const WEB = `http://127.0.0.1:${port}`;
			// A project page that embeds a web frame, loads a web script, and a web fetch; and a nested project page the web frame tries to open.
			put("site/inner.html", `<!doctype html><script>fetch(${JSON.stringify(WEB)}+'/report?inner=1')</script>`);
			put("site/embed.html", `<!doctype html><title>embed</title><script src="secret.js"></script><script src="${WEB}/ext.js"></script>` +
				`<iframe id="web" src="${WEB}/frame.html"></iframe><iframe id="web2" src="${WEB}/probe.html"></iframe>`);
			put("site/ownframe.html", '<!doctype html><title>own</title><iframe id="f" src="inner.html"></iframe>');

			// --- windows ---------------------------------------------------------------------------------------------------
			const mk = (partition) => {
				const w = new BrowserWindow({ show: false, width: 500, height: 400, webPreferences: partition ? { partition, sandbox: true, contextIsolation: true } : pp.viewerWebPreferences() });
				wins.push(w);
				return w;
			};
			const open = async (win, url, extra = 800) => {
				const wc = win.webContents;
				let code = null;
				wc.on("did-navigate", (_e, _u, c) => { code = c; });
				try { await Promise.race([wc.loadURL(url), sleep(8000)]); } catch (e) { code = code || "failed:" + e.code; }
				await sleep(extra);
				return { wc, code };
			};
			const js = (wc, code) => wc.executeJavaScript(code, true);
			const until = async (fn, ms = 6000) => { for (let t = 0; t < ms; t += 100) { try { if (await fn()) return true; } catch { /* retry */ } await sleep(100); } return false; };

			// 1. the page: relative and root-absolute CSS, script, image, font
			{
				const { wc } = await open(mk(), `${base}/site/index.html`, 1200);
				const r = await js(wc, `(async()=>({rel:getComputedStyle(document.getElementById('rel')).color,abs:getComputedStyle(document.getElementById('abs')).color,
					relJs:window.__rel,absJs:window.__abs,img:document.getElementById('img').naturalWidth,origin:location.origin,
					font:await document.fonts.load('16px TestFont').then(f=>f.length>0).catch(()=>false)}))()`);
				check("page: relative CSS", r.rel === "rgb(1, 2, 3)", r.rel);
				check("page: root-absolute CSS", r.abs === "rgb(4, 5, 6)", r.abs);
				check("page: relative and root-absolute script", r.relJs === 1 && r.absJs === 1, JSON.stringify(r));
				check("page: image", r.img === 2, r.img);
				check("page: font", fs.existsSync(path.join(root, "site", "font.woff2")) ? r.font === true : false, "font " + r.font);
				check("page: origin is the project host", r.origin === base, r.origin);
				// headers, Range, HEAD, errors, permissions: all from this page
				const h = await js(wc, `(async()=>{const o={};const hd=async(u,init)=>{const r=await fetch(u,init);const t=await r.text();return{status:r.status,ct:r.headers.get('content-type'),cc:r.headers.get('cache-control'),nosniff:r.headers.get('x-content-type-options'),cr:r.headers.get('content-range'),cl:r.headers.get('content-length'),len:t.length,text:t}};
					o.html=await hd('/site/index.html');o.css=await hd('/site/style.css');o.pdf=await hd('/site/doc.pdf');o.svg=await hd('/site/evil.svg');
					o.range=await hd('/site/range.txt',{headers:{Range:'bytes=0-9'}});o.suffix=await hd('/site/range.txt',{headers:{Range:'bytes=-5'}});o.bad=await hd('/site/range.txt',{headers:{Range:'bytes=500-600'}});
					o.head=await hd('/site/range.txt',{method:'HEAD'});o.post=await hd('/site/index.html',{method:'POST',body:'x'});
					o.dot=await hd('/.git/config');o.dot2=await hd('/.hidden/x.txt');o.missing=await hd('/site/nope.txt');o.folder=await hd('/site/');o.enc=await hd('/site/a%2fb');
					o.up=await hd('/%2e%2e/outside.txt');o.up2=await hd('/site/../../outside.txt');o.link=await hd('/link/secret.txt');
					return o})()`);
				check("headers: content types from the module", h.html.ct === "text/html; charset=utf-8" && h.css.ct === "text/css; charset=utf-8" && h.pdf.ct === "application/pdf" && h.svg.ct === "image/svg+xml", JSON.stringify([h.html.ct, h.css.ct, h.pdf.ct, h.svg.ct]));
				check("headers: no-cache and nosniff on every response", [h.html, h.pdf, h.range, h.missing, h.dot].every((x) => x.cc === "no-cache" && x.nosniff === "nosniff"), JSON.stringify([h.html.cc, h.html.nosniff, h.missing.cc]));
				check("Range: 206 with Content-Range, 10 bytes", h.range.status === 206 && h.range.cr === "bytes 0-9/100" && h.range.len === 10, JSON.stringify(h.range));
				check("Range: suffix range", h.suffix.status === 206 && h.suffix.cr === "bytes 95-99/100" && h.suffix.len === 5, JSON.stringify(h.suffix));
				check("Range: unsatisfiable is 416", h.bad.status === 416, h.bad.status);
				check("HEAD: 200, a length, no body", h.head.status === 200 && h.head.cl === "100" && h.head.len === 0, JSON.stringify(h.head));
				check("POST: 405", h.post.status === 405, h.post.status);
				check("dot-folders refused (403)", h.dot.status === 403 && h.dot2.status === 403 && !h.dot.text.includes("gitconfig"), `${h.dot.status} ${h.dot2.status}`);
				check("a missing file and a folder: 404", h.missing.status === 404 && h.folder.status === 404, `${h.missing.status} ${h.folder.status}`);
				check("encoded slash: 400", h.enc.status === 400, h.enc.status);
				check("a path outside the project is not served", ![h.up, h.up2].some((x) => x.status === 200 || x.text.includes("OUTSIDE-SECRET")), `${h.up.status} ${h.up2.status}`);
				check("a junction leading outside: 403", h.link.status === 403 && !h.link.text.includes("OUTSIDE-SECRET"), h.link.status);
				const pages = [h.dot, h.dot2, h.missing, h.folder, h.enc, h.post, h.bad, h.link].map((x) => x.text).join("\n");
				check("error pages reveal no path", !pages.includes(tmp) && !pages.includes("pi-crust-vf") && !/[A-Za-z]:\\/.test(pages) && h.missing.len < 400, pages.slice(0, 120));
				const rights = await js(wc, `(async()=>{const o={};o.geo=(await navigator.permissions.query({name:'geolocation'})).state;o.notif=Notification.permission;
					o.cam=await navigator.mediaDevices.getUserMedia({video:true}).then(()=>'granted',e=>e.name);o.sw=await navigator.serviceWorker.register('/site/app.js').then(()=>'registered',()=>'refused');
					o.node=[typeof require,typeof process,typeof window.crust,typeof window.electron].join(',');o.cookie=document.cookie;o.ls=localStorage.getItem('dev');
					o.popup=window.open('about:blank')===null;return o})()`);
				check("permissions denied (location, notifications, camera)", rights.geo === "denied" && rights.notif === "denied" && rights.cam !== "granted", JSON.stringify(rights));
				check("no service worker", rights.sw === "refused", rights.sw);
				check("no preload, no Node", rights.node === "undefined,undefined,undefined,undefined", rights.node);
				check("no popup", rights.popup && BrowserWindow.getAllWindows().length === wins.length + 1 /* the app window */, `${rights.popup} ${BrowserWindow.getAllWindows().length}/${wins.length}`);
			}

			// 2. PDF in the viewer, SVG with a script, a changed file after reload
			{
				const { wc, code } = await open(mk(), `${base}/site/doc.pdf`, 1500);
				const frames = wc.mainFrame.framesInSubtree.map((f) => f.url);
				check("PDF opens top-level (200, Chromium's viewer frame)", code === 200 && frames.some((u) => u.startsWith("chrome-extension://")), JSON.stringify({ code, frames }));
			}
			{
				const { wc } = await open(mk(), `${base}/site/evil.svg`, 800);
				check("SVG with a script runs as a page", wc.getTitle() === "svg-script-ran", wc.getTitle());
			}
			{
				const { wc } = await open(mk(), `${base}/site/change.html`, 600);
				const v1 = await js(wc, "window.__v");
				fs.writeFileSync(path.join(root, "site", "change.js"), "window.__v=2");
				wc.reload();
				await sleep(900);
				const v2 = await js(wc, "window.__v");
				check("a changed file shows after reload", v1 === 1 && v2 === 2, `${v1} -> ${v2}`);
			}

			// 3. another project's host label, and the scheme on other sessions
			{
				const { code } = await open(mk(), `${pp.SCHEME}://${otherHost}/site/secret.js`, 300);
				const mine = await open(mk(), `${base}/site/secret.js`, 300);
				check("another project's host label: 404 (this project's: 200)", code === 404 && mine.code === 200, `${code} / ${mine.code}`);
				const stale = await open(mk(), `${pp.SCHEME}://p-0000000000000000/site/secret.js`, 300);
				check("an unknown host label: 404", stale.code === 404, stale.code);
				const dev = session.fromPartition("persist:devbrowser");
				check("handler only on persist:viewer-project", session.fromPartition(pp.PARTITION).protocol.isProtocolHandled(pp.SCHEME) && !dev.protocol.isProtocolHandled(pp.SCHEME) && !session.defaultSession.protocol.isProtocolHandled(pp.SCHEME), "");
				const devWin = await open(mk("persist:devbrowser"), `${base}/site/secret.js`, 300);
				check("persist:devbrowser cannot load a project file", devWin.code !== 200, devWin.code);
			}

			// 4. a project page: a web frame cannot load project files, the page itself can load web resources
			{
				const own = await open(mk(), `${base}/site/ownframe.html`, 800);
				check("guard: a project page may embed a project page (positive control)", reports.some((r) => r.inner === "1"), JSON.stringify(reports));
				reports.length = 0;
				const dev = session.fromPartition("persist:devbrowser");
				// something in persist:devbrowser first: a cookie and a localStorage value for the same loopback origin
				await dev.cookies.set({ url: WEB + "/", name: "devcookie", value: "devbrowser-cookie" });
				const dw = mk("persist:devbrowser");
				await open(dw, `${WEB}/ls-set.html`, 300);
				const dw2 = mk("persist:devbrowser");
				const back = await open(dw2, `${WEB}/ls-get.html`, 300);
				check("control: persist:devbrowser holds its cookie and localStorage value", back.wc.getTitle() === "devbrowser-value|devcookie=devbrowser-cookie", back.wc.getTitle());
				seenCookies.length = 0;
				const { wc } = await open(mk(), `${base}/site/embed.html`, 2500);
				const r = await js(wc, "({secret:window.__secret,ext:window.__ext})");
				check("project page loads a web script (allowed) and its own script", r.ext === 1 && r.secret === 1, JSON.stringify(r));
				const rep = reports.find((x) => x.frame === "1");
				check("guard: web frame in a project page cannot load a project script", rep && rep.script === "blocked", JSON.stringify(rep));
				check("guard: ... an image", rep && rep.img === "blocked", JSON.stringify(rep));
				check("guard: ... fetch", rep && rep.fetch === "blocked", JSON.stringify(rep));
				check("guard: ... a stylesheet", rep && rep.css === "blocked", JSON.stringify(rep));
				check("guard: ... a nested frame", rep && !reports.some((x) => x.inner === "1"), JSON.stringify(reports));
				const probe = reports.find((x) => x.probe === "1");
				check("persist:devbrowser: nothing visible to the project page's web frame (localStorage, cookie)", probe && probe.ls === "null" && probe.cookie === "" && seenCookies.length === 0, JSON.stringify({ probe, seenCookies }));
				const loose = reports.length;
				// the same web page as a top-level page in the project session
				const lw = await open(mk(), `${WEB}/frame.html`, 2500);
				const rep2 = reports.slice(loose).find((x) => x.frame === "1");
				check("guard: a web page (top-level) on this session cannot load project files", rep2 && rep2.script === "blocked" && rep2.img === "blocked" && rep2.fetch === "blocked" && rep2.css === "blocked", JSON.stringify(rep2));
				void own; void lw;
			}

			// 5. the address helpers
			{
				const a = pp.toAddress(root, "docs\\my file é.html");
				check("address: project path to address and back", a === `${base}/docs/my%20file%20%C3%A9.html` && pp.fromAddress(root, a) === "docs/my file é.html" && pp.belongsToProject(root, a), a);
				check("address: another project, a web address, a bad address do not belong", !pp.belongsToProject(root, `${pp.SCHEME}://${otherHost}/x`) && !pp.belongsToProject(root, "https://example.com/") && !pp.belongsToProject(root, "nope") && pp.fromAddress(null, a) === null, "");
			}
		} catch (e) {
			return { checks, fatal: String(e && e.stack ? e.stack : e).slice(0, 400) };
		} finally {
			setRoot(null);
			for (const w of wins) { try { w.destroy(); } catch { /* gone */ } }
			if (server) server.close();
			try { await session.fromPartition("persist:devbrowser").clearStorageData(); } catch { /* ignore */ }
			try { await session.fromPartition(pp.PARTITION).clearStorageData(); } catch { /* ignore */ }
			if (tmp) try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
		}
		return { checks };
	});
}

module.exports = { register };
