"use strict";
// The address `pi-project://p-<hash>/<path>`: a project's files for Viewer pages (spec: Viewer tabs and project files, section C and
// "Spike result"). Main process only. `registerScheme` runs before the app is ready; `register` returns the registry that puts the
// handler and the guard on ONE session per project, `persist:viewer-project-<host label>`, the first time that project is used, and on
// no other session (not `persist:devbrowser`, not the default session). So a cookie or storage a web site set through one project's
// page is not there in another project's page. Every request goes through project-files.js `open` for the CURRENT project root.
// Pages on these sessions have no preload, no permission, no download and no popup.
const fs = require("node:fs");
const { Readable } = require("node:stream");
const pf = require("./project-files");

const SCHEME = "pi-project";
const PARTITION_PREFIX = "persist:viewer-project-";
// The session of a project: one per host label (the label is p-<16 hex>, valid in a partition name).
const partitionFor = (root, files = pf) => PARTITION_PREFIX + files.hostFor(root);

// Options the spike proved (viewer-spike RESULT.md). No corsEnabled, bypassCSP, codeCache or plugins; service workers stay off.
const SCHEME_PRIVILEGES = { standard: true, secure: true, supportFetchAPI: true, stream: true };
function registerScheme(protocol) {
	protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: SCHEME_PRIVILEGES }]);
}

// --- addresses ----------------------------------------------------------------------------------------------------------------
// A project path ("docs/a b.html", forward or back slashes, an optional leading slash) -> its address.
function toAddress(root, projectPath, files = pf) {
	const segs = String(projectPath == null ? "" : projectPath).replace(/\\/g, "/").split("/").filter((s) => s !== "");
	return `${SCHEME}://${files.hostFor(root)}/${segs.map(encodeURIComponent).join("/")}`;
}
// An address -> the project path ("docs/a b.html"), or null when it is not an address of THIS project (another scheme, another
// project's host label, no root). No file check here: that is `resolve`'s job.
function fromAddress(root, address, files = pf) {
	let u;
	try { u = new URL(String(address)); } catch { return null; }
	if (u.protocol !== SCHEME + ":" || !root || !files.hostMatches(u.hostname, root)) return null;
	let p;
	try { p = decodeURIComponent(u.pathname); } catch { return null; }
	return p.replace(/^\/+/, "");
}
function belongsToProject(root, address, files = pf) {
	return fromAddress(root, address, files) !== null;
}

// --- the guard ----------------------------------------------------------------------------------------------------------------
// A `pi-project://` request is allowed only when it comes from a project page of the CURRENT project. What the request details
// reliably give: `resourceType`, and `frame`, whose `url` and `parent` chain we read. (Electron 45, measured by the step viewer-files:
// for a script, image, font, stylesheet or fetch `frame` is the requesting document's frame; for a top-level navigation it is the
// top frame being navigated, its URL still the old page or blank; for a frame (`subFrame`) it is the NEW frame being created, URL
// blank, so its parent is the requester.) Referrer, Sec-Fetch-* and Origin are empty on this scheme (spike point 5): not used.
//   - mainFrame: a top-level navigation. Who started it cannot be told (the app's loadURL and a page's `location=` look the same);
//     it is allowed when the frame is a top frame. The result is a project page in the top frame, which the web page that
//     started it cannot read. Task 9 keeps the app's own navigation rules.
//   - subFrame: the new frame must be fresh (blank) or already a project page, and EVERY ancestor must be a project page
//     of the current project (or a frame such a page made itself, see below): a project page inside a web page, or a web frame
//     opening a project page, is cancelled.
//   - everything else (script, image, font, stylesheet, fetch, media...): the requesting frame AND every ancestor must be
//     project pages of the current project, or frames such pages made themselves (about:srcdoc, about:blank, blob: of this
//     project) below a project page. An http or https frame in a project page fails, and so does everything under it; a request
//     with no frame (a worker, a frame that is gone) fails: the default is cancel.
// A frame a project page makes itself has no address of its own: `about:srcdoc`, `about:blank`, or `blob:pi-project://<label>/<id>`.
// Such a frame is the project's own content when every frame above it is a project page or such a frame too, and the top is a
// project page. A sandboxed frame looks the same to this guard (its flags are not in the request details): decided to allow it,
// like any such frame; the sandbox only takes capabilities away from it, and the step viewer-files has a case for it.
const SELF_MADE = /^about:(?:srcdoc|blank)$/i;
function ownFrame(root, url, files) {
	if (SELF_MADE.test(url)) return true;
	return /^blob:/i.test(url) && belongsToProject(root, url.slice(5), files);
}
// `urls`: the frames from the requesting one up to the top. True when the top is a project page and each one below is a project
// page or a frame such a page made itself.
function allMine(root, urls, files) {
	if (urls.length === 0) return false;
	if (!belongsToProject(root, urls[urls.length - 1], files)) return false;
	return urls.slice(0, -1).every((u) => belongsToProject(root, u, files) || ownFrame(root, u, files));
}
function guardAllows(d, root, files = pf) {
	const chain = [];
	for (let f = d && d.frame; f; f = f.parent) {
		let url = "";
		try { url = f.url; } catch { /* a frame that is gone */ }
		chain.push(url);
		if (chain.length > 32) return false;
	}
	if (d && d.resourceType === "mainFrame") return chain.length <= 1; // the frame being navigated is the top frame (its current page may be blank or anything)
	if (d && d.resourceType === "subFrame") {
		// chain[0] is the NEW frame (blank, or already a project page); the rest are its ancestors.
		const rest = chain.slice(1);
		return chain.length >= 2 && (chain[0] === "" || SELF_MADE.test(chain[0]) || belongsToProject(root, chain[0], files)) && allMine(root, rest, files);
	}
	return allMine(root, chain, files);
}

// --- responses ----------------------------------------------------------------------------------------------------------------
const ERROR_TEXT = {
	400: ["Bad address", "This address is not valid."],
	403: ["Not available", "This file cannot be shown."],
	404: ["Not found", "This file is not in the project."],
	405: ["Not allowed", "Only GET and HEAD are allowed."],
	416: ["Range not satisfiable", "That part of the file does not exist."],
};
function errorPage(status, method, extra = {}) {
	const [title, text] = ERROR_TEXT[status] || ERROR_TEXT[404];
	const body = `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:14px system-ui,sans-serif;padding:2em;color:#444"><h3>${title}</h3><p>${text}</p></body>`;
	return new Response(method === "HEAD" ? null : body, {
		status,
		headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff", ...(status === 405 ? { Allow: "GET, HEAD" } : {}), ...extra },
	});
}

// The 200 and 206 bodies are streamed from the open handle `open` checked, and never past the size it reported: a file that
// grew after the check is cut at that size, one that shrank ends the body early (the load then fails; it is never over-long).
function serve(request, root, files = pf, hostCheck = true) {
	const method = request.method;
	let u;
	try { u = new URL(request.url); } catch { return errorPage(400, method); }
	if (method !== "GET" && method !== "HEAD") return errorPage(405, method);
	if (hostCheck && !files.hostMatches(u.hostname, root)) return errorPage(404, method); // another project, or a late request from an old tab
	const r = files.open(root, u.pathname, method);
	if (!r.ok) return errorPage(r.status === 400 || r.status === 403 || r.status === 405 ? r.status : 404, method);
	const close = () => { try { fs.closeSync(r.fd); } catch { /* closed */ } };
	try {
		const headers = { "Content-Type": r.contentType, "Accept-Ranges": "bytes", "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" };
		const size = r.size;
		const head = method === "HEAD";
		const body = (start, end) => {
			if (head || size === 0) { close(); return null; }
			return Readable.toWeb(fs.createReadStream(null, { fd: r.fd, start, end, autoClose: true }));
		};
		const m = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("range") || "");
		if (m && (m[1] !== "" || m[2] !== "")) {
			const start = m[1] === "" ? Math.max(0, size - +m[2]) : +m[1];
			const end = m[1] === "" || m[2] === "" ? size - 1 : Math.min(+m[2], size - 1);
			if (start > end || start >= size) { close(); return errorPage(416, method, { "Content-Range": `bytes */${size}` }); }
			headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
			headers["Content-Length"] = String(end - start + 1);
			return new Response(body(start, end), { status: 206, headers });
		}
		headers["Content-Length"] = String(size);
		return new Response(body(0, size - 1), { status: 200, headers });
	} catch (e) {
		close();
		throw e;
	}
}

// --- the sessions -------------------------------------------------------------------------------------------------------------
// opts: { session, app, getRoot, selftest, breakMode, onRequest(details) }. `onRequest` hears every request the guard let through
// (details.webContentsId says which page asked; the Viewer's live reload uses it to know which files a page loaded). `breakMode` ("guard" | "host") only counts when `selftest` is true: the
// deliberate breaks of the selftest step `viewer-files` (the step must then fail).
// Returns the registry; `ensure(root)` sets up the project's session on first use and returns it. Nothing is put on any other session.
let current = null;
function register({ session, app, getRoot, selftest = false, breakMode = "", onRequest = null }) {
	const brk = selftest ? breakMode : "";
	const sessions = new Map(); // host label -> session
	const known = new Set();
	// Every page on these sessions: no popups, no new windows. (No preload: the creator sets none, see viewerWebPreferences.)
	const harden = (wc) => {
		wc.setWindowOpenHandler(() => ({ action: "deny" }));
	};
	function ensure(root) {
		const label = pf.hostFor(root);
		const had = sessions.get(label);
		if (had) return had;
		const ses = session.fromPartition(partitionFor(root));
		sessions.set(label, ses);
		known.add(ses);
		ses.protocol.handle(SCHEME, async (request) => {
			try {
				let host = "";
				try { host = new URL(request.url).hostname.toLowerCase(); } catch { /* serve answers 400 */ }
				if (brk !== "host" && host !== label) return errorPage(404, request.method); // this session serves its own project only
				return serve(request, getRoot(), pf, brk !== "host");
			} catch {
				return errorPage(404, request.method);
			}
		});
		ses.webRequest.onBeforeRequest({ urls: [SCHEME + "://*/*"] }, (details, cb) => {
			let ok = false;
			try { ok = brk === "guard" || guardAllows(details, getRoot()); } catch { /* cancel */ }
			cb({ cancel: !ok });
			if (ok && onRequest) { try { onRequest(details); } catch { /* a listener must not break a load */ } }
		});
		// No permission of any kind (camera, microphone, location, notifications, midi, clipboard...), no device, no download.
		ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
		ses.setPermissionCheckHandler(() => false);
		ses.setDevicePermissionHandler(() => false);
		ses.on("will-download", (e) => e.preventDefault());
		return ses;
	}
	if (app) app.on("web-contents-created", (_e, wc) => { if (known.has(wc.session)) harden(wc); });
	current = { ensure, sessions, harden };
	return current;
}
// The tab model calls this before it creates a project page: the session of that project exists, with handler and guard.
function ensureSession(root) {
	if (!current) throw new Error("pi-project is not registered");
	return current.ensure(root);
}

// What a Viewer page of a project may be created with: the project's own partition, sandbox, no Node, no preload.
const viewerWebPreferences = (root, files = pf) => ({ partition: partitionFor(root, files), sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false });

module.exports = { SCHEME, PARTITION_PREFIX, partitionFor, SCHEME_PRIVILEGES, registerScheme, register, ensureSession, toAddress, fromAddress, belongsToProject, guardAllows, serve, errorPage, viewerWebPreferences };
