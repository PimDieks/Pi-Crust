"use strict";
// The address `pi-project://p-<hash>/<path>`: a project's files for Viewer pages (spec: Viewer tabs and project files, section C and
// "Spike result"). Main process only. `registerScheme` runs before the app is ready; `register` puts the handler on ONE session,
// `persist:viewer-project`, never on `persist:devbrowser` or the default session. Every request goes through project-files.js `resolve`
// for the CURRENT project root. Pages on this session have no preload, no permission, no download and no popup.
const fs = require("node:fs");
const { Readable } = require("node:stream");
const pf = require("./project-files");

const SCHEME = "pi-project";
const PARTITION = "persist:viewer-project";

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
//     of the current project: a project page inside a web page, or a web frame opening a project page, is cancelled.
//   - everything else (script, image, font, stylesheet, fetch, media...): the requesting frame AND every ancestor must be
//     project pages of the current project. An http or https frame in a project page fails; a request with no frame (a worker,
//     a frame that is gone) fails: the default is cancel.
function guardAllows(d, root, files = pf) {
	const mine = (url) => belongsToProject(root, url, files);
	const chain = [];
	for (let f = d && d.frame; f; f = f.parent) {
		let url = "";
		try { url = f.url; } catch { /* a frame that is gone */ }
		chain.push(url);
		if (chain.length > 32) return false;
	}
	if (d && d.resourceType === "mainFrame") return chain.length <= 1; // the frame being navigated is the top frame (its current page may be blank or anything)
	if (d && d.resourceType === "subFrame") {
		const rest = chain.slice(1);
		return chain.length >= 2 && (chain[0] === "" || chain[0] === "about:blank" || mine(chain[0])) && rest.every(mine);
	}
	return chain.length > 0 && chain.every(mine);
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

function serve(request, root, files = pf, hostCheck = true) {
	const method = request.method;
	let u;
	try { u = new URL(request.url); } catch { return errorPage(400, method); }
	if (method !== "GET" && method !== "HEAD") return errorPage(405, method);
	if (hostCheck && !files.hostMatches(u.hostname, root)) return errorPage(404, method); // another project, or a late request from an old tab
	const r = files.resolve(root, u.pathname, method);
	if (!r.ok) return errorPage(r.status === 400 || r.status === 403 || r.status === 405 ? r.status : 404, method);
	const headers = { "Content-Type": r.contentType, "Accept-Ranges": "bytes", "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" };
	const size = r.size;
	const head = method === "HEAD";
	const m = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("range") || "");
	if (m && (m[1] !== "" || m[2] !== "")) {
		const start = m[1] === "" ? Math.max(0, size - +m[2]) : +m[1];
		const end = m[1] === "" || m[2] === "" ? size - 1 : Math.min(+m[2], size - 1);
		if (start > end || start >= size) return errorPage(416, method, { "Content-Range": `bytes */${size}` });
		headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
		headers["Content-Length"] = String(end - start + 1);
		return new Response(head ? null : Readable.toWeb(fs.createReadStream(r.file, { start, end })), { status: 206, headers });
	}
	headers["Content-Length"] = String(size);
	return new Response(head ? null : Readable.toWeb(fs.createReadStream(r.file)), { status: 200, headers });
}

// --- the session --------------------------------------------------------------------------------------------------------------
// opts: { session, app, getRoot, selftest, breakMode }. `breakMode` ("guard" | "host") only counts when `selftest` is true: the
// deliberate breaks of the selftest step `viewer-files` (the step must then fail).
function register({ session, app, getRoot, selftest = false, breakMode = "" }) {
	const ses = session.fromPartition(PARTITION);
	const brk = selftest ? breakMode : "";
	ses.protocol.handle(SCHEME, async (request) => {
		try {
			return serve(request, getRoot(), pf, brk !== "host");
		} catch {
			return errorPage(404, request.method);
		}
	});
	ses.webRequest.onBeforeRequest({ urls: [SCHEME + "://*/*"] }, (details, cb) => {
		let ok = false;
		try { ok = brk === "guard" || guardAllows(details, getRoot()); } catch { /* cancel */ }
		cb({ cancel: !ok });
	});
	// No permission of any kind (camera, microphone, location, notifications, midi, clipboard...), no device, no download.
	ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
	ses.setPermissionCheckHandler(() => false);
	ses.setDevicePermissionHandler(() => false);
	ses.on("will-download", (e) => e.preventDefault());
	// Every page on this session: no popups, no new windows. (No preload: the creator sets none, see viewerWebPreferences.)
	const harden = (wc) => {
		wc.setWindowOpenHandler(() => ({ action: "deny" }));
	};
	if (app) app.on("web-contents-created", (_e, wc) => { if (wc.session === ses) harden(wc); });
	return { session: ses, harden, PARTITION };
}

// What a Viewer page on the project session may be created with: its own partition, sandbox, no Node, no preload.
const viewerWebPreferences = () => ({ partition: PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false });

module.exports = { SCHEME, PARTITION, SCHEME_PRIVILEGES, registerScheme, register, toAddress, fromAddress, belongsToProject, guardAllows, serve, errorPage, viewerWebPreferences };
