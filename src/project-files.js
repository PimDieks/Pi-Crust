"use strict";
// What a Viewer page may reach inside a project folder (spec: Viewer tabs and project files, section C).
// Pure: no Electron import. The file system, the platform and the path module can be injected for tests.
// `resolve` only decides; the caller opens `file`. Rules, in order: method (405), path syntax (400),
// dot segments (403), a folder or the root (404), then the real path of the file and of every parent
// must stay inside the real project root (403). `open` is `resolve` plus one open handle that is checked again after it is opened.
const nodeFs = require("node:fs");
const nodePath = require("node:path");
const crypto = require("node:crypto");

const MAX_PATH = 1024;
const TYPES = {
	html: "text/html; charset=utf-8",
	css: "text/css; charset=utf-8",
	js: "text/javascript; charset=utf-8",
	mjs: "text/javascript; charset=utf-8",
	json: "application/json; charset=utf-8",
	map: "application/json; charset=utf-8",
	svg: "image/svg+xml",
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	avif: "image/avif",
	ico: "image/x-icon",
	bmp: "image/bmp",
	woff: "font/woff",
	woff2: "font/woff2",
	ttf: "font/ttf",
	otf: "font/otf",
	pdf: "application/pdf",
	mp4: "video/mp4",
	webm: "video/webm",
	txt: "text/plain; charset=utf-8",
};
const OCTET = "application/octet-stream";
const IMAGE_EXT = new Set(["svg", "png", "jpg", "jpeg", "gif", "webp", "avif", "ico", "bmp"]);
const RESERVED = /^(con|prn|aux|nul|conin\$|conout\$|clock\$|com[1-9¹²³]|lpt[1-9¹²³])$/i;
// A control character, or one Windows reserves in names; this includes the colon (no alternate data streams).
// eslint-disable-next-line no-control-regex
const BAD_CHARS = /[\u0000-\u001f\u007f<>"|?*\\:]/;

// "%" and two hex digits that spell: a control character, " * . / : < > ? \ |   (matched on the text after the one decode)
const TWICE = /%(?:[01][0-9a-f]|7f|22|2[aef]|3[acef]|5c|7c)/i;

const refuse = (status, reason) => ({ ok: false, status, reason });

function extOf(name) {
	const m = /\.([^./\\]+)$/.exec(String(name || ""));
	return m ? m[1].toLowerCase() : "";
}
function contentTypeOf(name) {
	return TYPES[extOf(name)] || OCTET;
}
// What a Viewer tab shows for a file: a web page, an image (SVG counts as an image, Pim 2026-11-19), a PDF, or something it does not open.
function kindOf(p) {
	const e = extOf(p);
	if (e === "html") return "page";
	if (IMAGE_EXT.has(e)) return "image";
	if (e === "pdf") return "pdf";
	return "other";
}

function create(opts = {}) {
	const fs = opts.fs || nodeFs;
	const platform = opts.platform || process.platform;
	const path = opts.path || (platform === "win32" ? nodePath.win32 : nodePath.posix);
	const caseInsensitive = opts.caseInsensitive !== undefined ? !!opts.caseInsensitive : platform === "win32" || platform === "darwin";
	const real = (p) => (fs.realpathSync.native || fs.realpathSync)(p);
	const fold = (s) => (caseInsensitive ? s.toLowerCase() : s);
	const trimSep = (s) => (s.length > path.parse(s).root.length ? s.replace(/[\\/]+$/, "") : s);
	function inside(child, parent) {
		const c = fold(trimSep(child));
		const p = fold(trimSep(parent));
		if (c === p) return true;
		return c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
	}

	function parse(requestPath) {
		if (typeof requestPath !== "string") return refuse(400, "The path is not text.");
		if (requestPath.length > MAX_PATH) return refuse(400, "The path is longer than 1,024 characters.");
		if (/%(2f|5c)/i.test(requestPath)) return refuse(400, "An encoded slash or backslash is not allowed.");
		if (/%2e/i.test(requestPath)) return refuse(400, "An encoded dot is not allowed.");
		let decoded;
		try { decoded = decodeURIComponent(requestPath); } catch { return refuse(400, "The path is not valid text."); }
		// Decoded exactly once; the result is a literal name and is never decoded again. A file really named "100%ab" is asked for as
		// "100%25ab" and a file named "100%25ab" as "100%2525ab": both are served. What is refused is a second layer of encoding that
		// hides a character the rules below look for (a dot, a slash, a backslash, a colon, a control or Windows-reserved character).
		if (TWICE.test(decoded)) return refuse(400, "A path encoded twice is not allowed.");
		if (decoded.includes("\0")) return refuse(400, "A NUL character is not allowed.");
		if (!decoded.startsWith("/")) return refuse(400, "The path must start with a slash.");
		if (decoded.startsWith("//")) return refuse(400, "A network (UNC) path is not allowed.");
		const parts = decoded.slice(1).split("/");
		const folder = parts[parts.length - 1] === "";
		if (folder) parts.pop();
		const segs = [];
		for (const s of parts) {
			if (s === "") return refuse(400, "An empty path segment is not allowed.");
			if (BAD_CHARS.test(s)) return refuse(400, "A segment has a character that is not allowed (a colon, a control or a Windows-reserved character).");
			if (s.startsWith(".")) return refuse(403, "A segment starting with a dot is not served.");
			if (/[. ]$/.test(s)) return refuse(400, "A segment may not end in a dot or a space.");
			if (RESERVED.test(s.split(".")[0].replace(/ +$/, ""))) return refuse(400, "A Windows device name is not allowed.");
			segs.push(s);
		}
		return { ok: true, segs, folder };
	}

	function resolve(root, requestPath, method) {
		if (method !== "GET" && method !== "HEAD") return refuse(405, "Only GET and HEAD are allowed.");
		const p = parse(requestPath);
		if (!p.ok) return p;
		if (p.folder || p.segs.length === 0) return refuse(404, "A folder is never listed.");
		if (typeof root !== "string" || !path.isAbsolute(root)) return refuse(404, "There is no project folder.");
		let realRoot;
		try { realRoot = real(root); } catch { return refuse(404, "The project folder does not exist."); }
		let cur = realRoot;
		for (const seg of p.segs) {
			let next;
			try { next = real(path.join(cur, seg)); } catch (e) { return refuse(e && e.code === "EACCES" ? 403 : 404, "No such file."); }
			if (!inside(next, realRoot)) return refuse(403, "The real path is outside the project folder.");
			cur = next;
		}
		// The real on-disk name decides: a link may not lead to a dot file or folder either.
		const rel = cur.slice(trimSep(realRoot).length).replace(/^[\\/]+/, "");
		if (rel.split(/[\\/]/).some((x) => x.startsWith("."))) return refuse(403, "A segment starting with a dot is not served.");
		let st;
		try { st = fs.statSync(cur); } catch { return refuse(404, "No such file."); }
		// Hard links are accepted on purpose: a hard link is a second name for the same file, so a regular file inside the project
		// that is also linked from outside it cannot be told apart. Package managers create them for most files in node_modules, and
		// whoever can create such a link can already read its target. (Pinned by a test.) Symbolic links and junctions are different:
		// they are followed above and the real path must stay inside the project.
		if (!st.isFile()) return refuse(404, st.isDirectory() ? "A folder is never listed." : "Not a regular file.");
		return { ok: true, file: cur, contentType: contentTypeOf(p.segs[p.segs.length - 1]), size: st.size };
	}

	// `resolve`, then open the file ONCE and check the open handle: the name was checked before it was opened, and a link swapped in
	// between would make the open follow it. After the open: fstat the handle, resolve the same path again (inside-the-project test,
	// dot rule, regular file) and require that the handle is the very file (device and file id) the path resolves to now. Anything
	// else is a 403. The caller streams from `fd` and closes it; `size` is the handle's size at this moment.
	function open(root, requestPath, method) {
		const r = resolve(root, requestPath, method);
		if (!r.ok) return r;
		let fd;
		try { fd = fs.openSync(r.file, "r"); } catch (e) { return refuse(e && (e.code === "EACCES" || e.code === "EPERM") ? 403 : 404, "No such file."); }
		const fail = (status, reason) => { try { fs.closeSync(fd); } catch { /* closed */ } return refuse(status, reason); };
		try {
			const mine = fs.fstatSync(fd, { bigint: true });
			if (!mine.isFile()) return fail(404, "Not a regular file.");
			const again = resolve(root, requestPath, method);
			if (!again.ok) return fail(again.status === 404 ? 403 : again.status, "The file changed while it was opened.");
			const now = fs.statSync(again.file, { bigint: true });
			if (now.dev !== mine.dev || now.ino !== mine.ino) return fail(403, "The file changed while it was opened.");
			return { ok: true, file: again.file, fd, contentType: r.contentType, size: Number(mine.size) };
		} catch {
			return fail(403, "The file could not be checked.");
		}
	}

	// True only for a file that `resolve` would serve (dropped files, the agent tool).
	function isProjectPath(root, absolutePath) {
		if (typeof root !== "string" || typeof absolutePath !== "string") return false;
		if (!path.isAbsolute(root) || !path.isAbsolute(absolutePath) || absolutePath.includes("\0")) return false;
		const abs = path.normalize(absolutePath);
		const bases = [root];
		try { bases.push(real(root)); } catch { /* resolve() will refuse */ }
		const relUrl = (base) => "/" + abs.slice(trimSep(path.normalize(base)).length).replace(/^[\\/]+/, "").split(/[\\/]/).map(encodeURIComponent).join("/");
		const isUnder = (base) => inside(abs, base) && fold(trimSep(abs)) !== fold(trimSep(base));
		for (const base of bases) if (isUnder(base)) return resolve(root, relUrl(base), "GET").ok;
		// Reached through another spelling of the root (a link to it): judge by the real path, which must exist.
		try {
			const realRoot = real(root);
			const r = real(abs);
			if (inside(r, realRoot) && fold(trimSep(r)) !== fold(trimSep(realRoot))) return resolve(root, "/" + r.slice(trimSep(realRoot).length).replace(/^[\\/]+/, "").split(/[\\/]/).map(encodeURIComponent).join("/"), "GET").ok;
		} catch { /* not there */ }
		return false;
	}

	// Stable host label for pi-project://p-<hash>/...: one per project folder, so storage is separate per project.
	function hostFor(root) {
		const norm = fold(trimSep(path.resolve(String(root))));
		return "p-" + crypto.createHash("sha256").update(norm).digest("hex").slice(0, 16);
	}
	// Back-check: does this host belong to the current project? A late request from an old tab says no.
	function hostMatches(host, root) {
		if (typeof host !== "string" || !root) return false;
		return host.toLowerCase() === hostFor(root);
	}

	return { resolve, open, isProjectPath, hostFor, hostMatches, kindOf, contentTypeOf };
}

const defaults = create();
module.exports = { ...defaults, create, kindOf, contentTypeOf, MAX_PATH };
