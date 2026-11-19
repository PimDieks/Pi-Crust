"use strict";
// The Viewer's tabs, main process (spec: Viewer tabs and project files, sections B and G task 4). One WebContentsView per tab, all with the
// same bounds, only the active one visible. The list logic (order, limit, reuse) is src/viewer-tabs-list.js; this file owns the views.
//
// Two kinds of tab, by session, and a tab never changes its session:
//   web      persist:devbrowser, exactly as the single Viewer page was (http and https).
//   project:<label>  persist:viewer-project-<label>, one session per project, with viewerWebPreferences(root) (pi-project:// addresses of
//            the open project, project-protocol.js rules).
// A top-level move that would cross sessions (a project page to a web address, a web page to a project address) is cancelled and opens
// in a tab of the other session instead: a tab on the same site if there is one, else a new tab.
//
// Everything that used the one view acts on the ACTIVE tab: `activeView()` is what ctx.browserView returns, so Tweak, the browser tools,
// Annotate, snapshots, Stories and Mendix keep working unchanged. A switch of tab (task 6): a running pick is cancelled, then every
// listener added with onLeave() runs for the tab being left (browser-tools-main.js detaches CDP and clears the target and the forced
// states; design-main.js removes the Tweak CSS it inserted there), then the new tab is active and onEnter() listeners run (the colour
// scheme is applied to it). Stories and Mendix keep their one remembered address (task 14). The kind of the active tab (page, image,
// pdf; src/viewer-kind.js) decides which tools act: pick refuses on an image or a PDF, and an image tab is shown at its real size or
// fitted (setImageZoom).
const L = require("./viewer-tabs-list");
const pp = require("./project-protocol");
const pf = require("./project-files");
const K = require("./viewer-kind");
const S = require("./viewer-tabs-store");
const VO = require("./viewer-open-logic");
const RL = require("./viewer-reload");
const { fileURLToPath } = require("node:url");

const WEB_PARTITION = "persist:devbrowser";

// deps: { WebContentsView, nativeTheme, getWin, send, isLocal, isWin, devUrl, getRoot, getZoomLevel, relayout, setErrorHidden,
//         breakMode (selftest only), files, protocol,
//         store: { read(root), write(root, value | null) } (the remembered tabs, in settings.json) }
function create(deps) {
	const files = deps.files || pf;
	const protocol = deps.protocol || pp;
	const list = L.create();
	const brk = deps.selftest ? deps.breakMode || "" : ""; // selftest only: the deliberate breaks (reload-*, site-*) of the step viewer-reload
	const logic = VO.create({ files, protocol, breakMode: brk });
	// Live reload (spec task 12): which real files each project tab uses, watched by viewer-reload.js; a change arrives in changed().
	const reload = RL.create({ breakMode: brk, debounceMs: brk === "reload-storm" ? 0 : undefined, onChange: (id) => changed(id) });
	const views = new Map(); // tab id -> WebContentsView
	let webSessionReady = false;
	// A project switch (projectWillChange until projectChanged) rebuilds the list: a tab asked for before it began must not be added after it
	// (it would belong to the old project), and none is added while it runs.
	let switching = false;
	let gen = 0;
	const SWITCHING = { ok: false, reason: "switching", message: "The project is changing. Try again in a moment." };
	let bg = deps.nativeTheme.shouldUseDarkColors ? "#1b1b1b" : "#eef0f0";
	let pickTab = null; // the tab a running pick is on
	const leaveFns = [];
	const enterFns = [];
	const guard = async (fn, arg) => {
		try { await Promise.race([fn(arg), new Promise((r) => setTimeout(r, 4000))]); } catch { /* a feature's cleanup must not block a switch */ }
	};
	// What a tool must clean on the tab being left; runs before the switch, with { id, wc, kind } of that tab.
	const leaveActive = async () => {
		const t = activeTab();
		if (!t) return;
		const info = { id: t.id, wc: wcOf(t), kind: t.kind };
		for (const fn of leaveFns) await guard(fn, info);
	};
	const enterActive = () => {
		const t = activeTab();
		if (!t) return;
		const info = { id: t.id, wc: wcOf(t), kind: t.kind };
		for (const fn of enterFns) { try { fn(info); } catch { /* ignore */ } }
	};

	const tabOf = (id) => L.find(list, id);
	const activeTab = () => L.active(list);
	const activeView = () => (activeTab() ? views.get(activeTab().id) : undefined);
	const wcOf = (tab) => (tab && views.get(tab.id) ? views.get(tab.id).webContents : null);
	const isActive = (tab) => !!tab && list.activeId === tab.id;

	const publicTab = (t) => ({ id: t.id, session: t.session, kind: t.kind, zoom: t.zoom || "fit", address: t.address, title: t.title, loading: t.loading, canGoBack: t.canGoBack, canGoForward: t.canGoForward, error: t.error, updated: !!t.updated });
	const snapshot = (changedId) => {
		const a = activeTab() || {};
		// The top-level fields are the ACTIVE tab's, as the single-page event had them (the UI keeps working); tabId says which tab changed.
		return {
			url: a.address || "",
			title: a.title || "",
			canGoBack: !!a.canGoBack,
			canGoForward: !!a.canGoForward,
			loading: !!a.loading,
			error: a.error || null,
			tabId: changedId || list.activeId,
			activeId: list.activeId,
			tabs: list.tabs.map(publicTab),
		};
	};
	const report = (tab) => {
		deps.send("browser:state", snapshot(tab ? tab.id : null));
		scheduleSave();
	};

	function sync(tab) {
		const wc = wcOf(tab);
		if (!wc || wc.isDestroyed() || tab.missing) return; // a file that is gone has no page: it keeps its stored address and title
		tab.address = wc.getURL() || tab.address;
		tab.title = wc.getTitle() || "";
		tab.loading = wc.isLoading();
		tab.canGoBack = wc.navigationHistory.canGoBack();
		tab.canGoForward = wc.navigationHistory.canGoForward();
		if (L.isProjectSession(tab.session)) {
			const p = protocol.fromAddress(deps.getRoot(), tab.address);
			tab.kind = p == null ? "page" : files.kindOf(p);
		} else {
			tab.kind = "page";
		}
	}

	// --- addresses --------------------------------------------------------------------------------------------------------------
	// What a tab may be asked to open: http(s), or a pi-project address of the open project that is a kind of file the Viewer shows.
	function accept(address) {
		let u;
		try { u = new URL(String(address)); } catch { return { ok: false, reason: "bad address" }; }
		if (u.protocol === "http:" || u.protocol === "https:") return { ok: true, url: u.href, session: "web" };
		if (u.protocol === protocol.SCHEME + ":") {
			const p = protocol.fromAddress(deps.getRoot(), address);
			if (p == null) return { ok: false, reason: "not this project" };
			if (files.kindOf(p) === "other") return { ok: false, reason: "not a file the Viewer shows" };
			return { ok: true, url: u.href, session: L.sessionOf(u.href) };
		}
		return { ok: false, reason: "bad address" };
	}

	// --- one tab's view ---------------------------------------------------------------------------------------------------------
	function setupWebSession(session) {
		if (webSessionReady) return;
		webSessionReady = true;
		// Web tabs: no permission is granted by default; only clipboard writes and fullscreen for local pages.
		const allowed = new Set(["clipboard-sanitized-write", "fullscreen"]);
		session.setPermissionRequestHandler((wc, permission, callback, details) => callback(allowed.has(permission) && deps.isLocal(details?.requestingUrl || wc.getURL())));
		session.setPermissionCheckHandler((_wc, permission, origin) => allowed.has(permission) && deps.isLocal(origin));
	}

	function buildView(tab) {
		const web = tab.session === "web";
		if (!web) protocol.ensureSession(deps.getRoot()); // this project's session, with its handler and guard, before the first page
		const view = new deps.WebContentsView({ webPreferences: web ? { partition: WEB_PARTITION, contextIsolation: true, sandbox: true } : protocol.viewerWebPreferences(deps.getRoot()) });
		views.set(tab.id, view);
		// Until a page paints (and for pages without their own background) show the app background, not white.
		view.setBackgroundColor(bg);
		deps.getWin().contentView.addChildView(view);
		const wc = view.webContents;
		if (web) setupWebSession(wc.session);
		const mine = () => !wc.isDestroyed() && views.get(tab.id) === view;
		const upd = () => {
			if (!mine()) return;
			sync(tab);
			report(tab);
		};
		wc.on("did-start-loading", upd);
		wc.on("did-stop-loading", upd);
		wc.on("did-navigate", () => {
			if (!mine()) return;
			wc.setZoomLevel(deps.getZoomLevel()); // Chromium keeps zoom per site; keep the app-wide level
			upd();
		});
		wc.on("did-navigate-in-page", upd);
		wc.on("page-title-updated", upd);
		// A failed page shows Chromium's own (white) error page on top of the UI. Hide the view instead so the themed message in
		// #browser-error shows; show it again on the next load. The error belongs to the tab; only the active tab's hides the view.
		wc.on("did-fail-load", (_e, code, desc, url, isMain) => {
			if (!isMain || code === -3 || !mine()) return;
			tab.error = { code, desc, url };
			if (isActive(tab)) {
				deps.setErrorHidden(true);
				deps.send("browser:error", { code, desc, url });
			}
			upd();
		});
		wc.on("did-start-navigation", (details) => {
			if (details.isMainFrame && !details.isSameDocument && mine()) watchPage(tab, details.url);
			if (!details.isMainFrame || details.isSameDocument || !tab.error) return;
			tab.error = null;
			if (isActive(tab)) deps.setErrorHidden(false);
		});
		// App shortcuts keep working while the embedded page has focus.
		wc.on("before-input-event", (event, input) => {
			if (input.type !== "keyDown") return;
			const k = input.key.toLowerCase();
			// The CmdOrCtrl modifier: command on macOS, Ctrl on Windows (sent on as ctrl: true, which the UI replays).
			const mod = deps.isWin ? input.control && !input.meta : input.meta && !input.control;
			const appKey =
				(mod && (["k", "1", "2", "3", "4", "5", "j", "n", "o", "[", "]", "{", "}", "c", "t"].includes(k) ? !input.alt : k === "b" || (k === "f" && input.shift && !input.alt))) ||
					(mod && input.alt && !input.shift && (k === "arrowleft" || k === "arrowright")) || // previous / next page
				(input.control && !input.meta && (input.code === "Backquote" || input.code === "Tab")) ||
				(["1", "2", "3"].includes(k) && input.control && (deps.isWin ? input.alt && !input.meta : input.meta && !input.alt)); // view switch
			// Close page: Ctrl+W on Windows; Option+Cmd+W on a Mac, where plain Cmd+W is the app menu's Close window and must not be taken from it.
			const closeKey = mod && !input.shift && (deps.isWin ? !input.alt && k === "w" : input.alt && input.code === "KeyW");
			if (appKey || closeKey) {
				event.preventDefault();
				deps.send("app:shortcut", { key: input.key, code: input.code, meta: input.meta, alt: input.alt, ctrl: input.control, shift: input.shift });
			}
		});
		// Popups: a web tab opens http(s) as a real window sharing the session (a login window); a project tab opens none.
		wc.setWindowOpenHandler(({ url }) =>
			web && /^https?:/i.test(url) ? { action: "allow", overrideBrowserWindowOptions: { width: 900, height: 750, parent: deps.getWin() } } : { action: "deny" },
		);
		// A top-level move to the other session never loads here: it opens in a tab of that session (see moveTo). A project tab only
		// ever loads addresses of the open project; a web tab keeps today's behaviour for everything that does not cross into a project.
		const isProjectScheme = (url) => {
			try { return new URL(String(url)).protocol === protocol.SCHEME + ":"; } catch { return false; }
		};
		// A web page may not cause a project tab or a switch of tab at all: its move to a project address is cancelled, nothing else happens.
		// Project tabs come only from the person (bar, tree, Editor, drop), from a project page's own links and from the agent's tool.
		const guardMove = (event, url, redirect) => {
			if (/^file:/i.test(String(url))) {
				// A file dropped straight onto the page moves it to a file: address, started by the browser itself (no initiating frame): that is a
				// drop, checked like every other. A page's own move to a file: address (it has an initiating frame) is cancelled, nothing else.
				event.preventDefault();
				if (!event.initiator && !redirect) fileDropped(String(url));
				return;
			}
			const a = accept(url);
			const toProject = a.ok && L.isProjectSession(a.session);
			if (web) {
				if (isProjectScheme(url)) event.preventDefault(); // any project address, this project's or another's
				return;
			}
			if (toProject && a.session === tab.session) return;
			event.preventDefault();
			if (a.ok && !toProject) moveTo(a.url).catch(() => {}); // a project page's own link to a web address opens in a web tab
		};
		wc.on("will-navigate", guardMove);
		wc.on("will-redirect", (event, url) => guardMove(event, url, true));
		// Only the active tab's events reach the browser tools: a background tab's navigation must not reset the active tab's target.
		const filtered = { on: (ev, fn) => wc.on(ev, (...a) => isActive(tab) && fn(...a)) };
		require("./browser-tools-main").attach?.(filtered);
		// An image tab: neutral background, shown fitted or at its real size (setImageZoom).
		wc.on("did-start-navigation", (d) => { if (d.isMainFrame && !d.isSameDocument) tab.imageKey = null; });
		wc.on("did-finish-load", () => { if (mine()) paintImage(tab).catch(() => {}); });
		return view;
	}

	// The drop that reached the page itself (see guardMove): the real path is checked by viewer-open-logic.js checkDropped (a network path is
	// refused before the file system is touched), then it opens as a dropped file does, or the refusal shows in the Viewer's reason line.
	async function fileDropped(url) {
		let abs = "";
		try { abs = fileURLToPath(url); } catch { /* a host the platform cannot read as a path */ }
		const r = abs ? logic.checkDropped(deps.getRoot(), abs) : { refuse: VO.R.invalid };
		if (r.refuse) return void deps.send("browser:notice", { message: r.refuse });
		const res = await openFile(protocol.toAddress(deps.getRoot(), r.file.path));
		if (!res.ok && res.message) deps.send("browser:notice", { message: res.message });
	}

	// --- the image tab -----------------------------------------------------------------------------------------------------------
	// Chromium's own image page, restyled: a neutral background (follows the app's light or dark) and one of two sizes. "fit": the whole
	// image inside the view, never enlarged. "actual": the file's real size (one image pixel per CSS pixel at the app's zoom; the view
	// scrolls). An SVG has no natural size in CSS, so its real size is its width and height (else its viewBox); its fit is the view.
	const imageBg = () => (deps.nativeTheme.shouldUseDarkColors ? "#2b2b2b" : "#dedede");
	async function paintImage(tab) {
		const wc = wcOf(tab);
		if (!wc || wc.isDestroyed() || tab.kind !== "image") return;
		if (tab.imageKey) { const k = tab.imageKey; tab.imageKey = null; await wc.removeInsertedCSS(k).catch(() => {}); }
		const mode = tab.zoom === "actual" ? "actual" : "fit";
		const svg = await wc.executeJavaScript(`(() => { const r = document.documentElement; if (!(r instanceof SVGSVGElement)) return null;
			const num = (v) => (/^\\s*[\\d.]+(px)?\\s*$/.test(v || "") ? parseFloat(v) : 0);
			const vb = r.viewBox && r.viewBox.baseVal; return { w: num(r.getAttribute("width")) || (vb && vb.width) || 300, h: num(r.getAttribute("height")) || (vb && vb.height) || 150 }; })()`, true).catch(() => null);
		let css = `html,body{background:${imageBg()}!important;margin:0!important}`;
		if (svg) {
			css += mode === "actual" ? `svg{width:${Math.round(svg.w)}px!important;height:${Math.round(svg.h)}px!important;max-width:none!important;max-height:none!important}` : `svg{width:100vw!important;height:100vh!important}`;
		} else {
			css += `body{display:flex!important;min-height:100vh!important}img{margin:auto!important;display:block!important;cursor:default!important;width:auto!important;height:auto!important;background:none!important;` +
				(mode === "actual" ? "max-width:none!important;max-height:none!important}" : "max-width:100vw!important;max-height:100vh!important}");
		}
		tab.imageKey = await wc.insertCSS(css).catch(() => null);
	}
	async function setImageZoom(mode) {
		const t = activeTab();
		if (!t || t.kind !== "image") return { ok: false, reason: "not an image" };
		t.zoom = mode === "actual" ? "actual" : "fit";
		await paintImage(t);
		report(t);
		return { ok: true, zoom: t.zoom };
	}

	function load(tab, address) {
		const wc = wcOf(tab);
		tab.address = address;
		tab.missing = false;
		if (wc) wc.loadURL(address).catch(() => {});
	}

	// --- operations -------------------------------------------------------------------------------------------------------------
	async function cancelPick() {
		const t = pickTab;
		if (!t) return;
		pickTab = null;
		if (deps.breakMode === "tabs-pick") return; // selftest only: the deliberate break (a switch leaves the pick running)
		const wc = wcOf(t);
		if (wc && !wc.isDestroyed()) await wc.executeJavaScript("window.__piPickCancel && window.__piPickCancel()", true).catch(() => {});
	}

	// `lazy`: a restored tab that is not shown yet: no view and no load until it is first shown (materialize).
	function makeTab(session, address, { activate = true, lazy = false, title = "", missing = false, unloaded = false } = {}) {
		const r = L.add(list, { session, address, title, loading: false, canGoBack: false, canGoForward: false, error: null, kind: "page" }, { activate });
		if (!r.ok) return r;
		if (L.isProjectSession(session)) {
			const p = protocol.fromAddress(deps.getRoot(), address);
			r.tab.kind = p == null ? "page" : files.kindOf(p); // known before the first load, so the tools see it at once
		}
		if (lazy) {
			r.tab.lazy = true;
			if (missing) markMissing(r.tab);
			else if (unloaded) markUnloaded(r.tab);
			return r;
		}
		buildView(r.tab);
		load(r.tab, address);
		return r;
	}

	// --- live reload (project files) -----------------------------------------------------------------------------------------------
	// A project tab watches the file it shows and the files that page loaded through the project address (the address handler reports each
	// request; requestSeen below), at most RL.MAX_FILES per tab, the list starting again at every navigation. A change, after a 250 ms quiet
	// pause, reloads the tab when it is the active one; a tab in the background is marked stale and reloads once when it is shown. A web tab
	// is never watched. A deleted or renamed page shows "This file no longer exists" and loads again when the file is back. The reload is
	// wc.reload(): no focus change, Chromium keeps the scroll position, and the tab's loading state shows for a moment. A running pick is
	// not cut off: the tab waits (stale) and reloads when the pick ends.
	const MAX_SEEN = 128; // distinct request paths looked at per page: the bound on resolve calls
	// The page's own file as a path under the real project folder, without the file having to exist (a deleted file is still watched, in
	// its folder, until it returns). null for anything that is not a plain project path.
	// It goes through project-files isProjectPath (RL.pageCandidate), so a link inside the project never makes the watcher look outside it.
	function pageCandidate(address) {
		const root = deps.getRoot();
		const p = protocol.fromAddress(root, address);
		if (p == null) return null;
		return RL.pageCandidate(root, p.split("/").filter(Boolean), { files });
	}
	function watchPage(tab, address) {
		reload.reset(tab.id);
		tab.reqSeen = new Set();
		if (!L.isProjectSession(tab.session)) return;
		const c = pageCandidate(address);
		if (c) reload.add(tab.id, c);
	}
	// From the address handler (project-protocol.js onRequest): a project page asked for a file.
	function requestSeen(d) {
		if (!d || d.resourceType === "mainFrame" || typeof d.webContentsId !== "number" || brk === "reload-deps") return;
		const tab = list.tabs.find((t) => {
			const v = views.get(t.id);
			return v && !v.webContents.isDestroyed() && v.webContents.id === d.webContentsId;
		});
		if (!tab || !L.isProjectSession(tab.session)) return;
		let u;
		try { u = new URL(d.url); } catch { return; }
		const root = deps.getRoot();
		if (!protocol.belongsToProject(root, d.url)) return;
		const seen = tab.reqSeen || (tab.reqSeen = new Set());
		if (seen.has(u.pathname) || seen.size >= MAX_SEEN) return;
		seen.add(u.pathname);
		const r = files.resolve(root, u.pathname, "GET");
		if (r.ok) reload.add(tab.id, r.file);
	}
	function changed(id) {
		const tab = tabOf(id);
		if (!tab) return;
		if (brk === "reload-web") {
			for (const t of list.tabs) if (t.session === "web" && wcOf(t)) { t.reloads = (t.reloads || 0) + 1; wcOf(t).reload(); }
		}
		if (!L.isProjectSession(tab.session)) return;
		if ((!isActive(tab) && brk !== "reload-bg") || pickTab === tab) {
			tab.stale = true;
			return;
		}
		reloadTab(tab);
	}
	function reloadTab(tab) {
		tab.stale = false;
		if (fileGone(tab)) return showMissing(tab);
		if (tab.lazy) return; // no page yet: it loads when shown
		tab.reloads = (tab.reloads || 0) + 1;
		if (tab.missing) return recheckMissing(tab);
		const wc = wcOf(tab);
		if (wc && !wc.isDestroyed()) wc.reload();
	}
	function showMissing(tab) {
		if (brk === "reload-delete") return;
		markMissing(tab);
		if (isActive(tab)) {
			deps.setErrorHidden(true);
			deps.send("browser:error", tab.error);
		}
		report(tab);
	}

	// --- a restored tab ----------------------------------------------------------------------------------------------------------
	const MISSING = "This file no longer exists";
	function markMissing(tab) {
		tab.missing = true;
		tab.error = { code: 404, desc: MISSING, url: tab.address, missing: true };
	}
	// A remembered web address that is not local (viewer-tabs-store.js): no view, no load. The tab shows its address and a Load button (the UI
	// reads error.unloaded); loadTab, from that click, is the only way it loads.
	function markUnloaded(tab) {
		tab.unloaded = true;
		tab.error = { code: 0, desc: "Not loaded yet", url: tab.address, unloaded: true };
	}
	function loadTab(id) {
		const tab = tabOf(id);
		if (!tab || !tab.unloaded) return { ok: false, reason: "nothing waiting" };
		const a = accept(tab.address);
		if (!a.ok || a.session !== "web") return { ok: false, reason: "refused" };
		tab.unloaded = false;
		tab.error = null;
		tab.lazy = false;
		buildView(tab);
		load(tab, a.url);
		if (isActive(tab)) {
			deps.setErrorHidden(false);
			deps.relayout();
		}
		report(tab);
		return { ok: true, tabId: tab.id };
	}
	// Is the file of a project tab gone now? (Same rules as every request.)
	function fileGone(tab) {
		if (!L.isProjectSession(tab.session)) return false;
		try {
			const r = files.resolve(deps.getRoot(), new URL(tab.address).pathname, "GET");
			return !r.ok && r.status === 404;
		} catch { return false; }
	}
	// First time a restored tab is shown: build its view and load it, unless its file is gone (then it keeps the message).
	function materialize(tab) {
		if (!tab.lazy || tab.unloaded) return;
		tab.lazy = false;
		buildView(tab);
		if (fileGone(tab)) {
			markMissing(tab);
			watchPage(tab, tab.address); // so the tab loads when the file comes back
		} else {
			tab.error = null;
			tab.missing = false;
			load(tab, tab.address);
		}
	}
	// Reload on a tab whose file was gone: look again.
	function recheckMissing(tab) {
		if (fileGone(tab)) return markMissing(tab);
		tab.error = null;
		deps.setErrorHidden(false);
		load(tab, tab.address);
	}

	function becameActive(tab) {
		tab.updated = false; // the person is looking at it now: the "updated" mark of a page the agent showed goes away
		materialize(tab);
		if (tab.stale) reloadTab(tab); // a page that changed while it was in the background loads once, now
		deps.setErrorHidden(!!tab.error);
		deps.relayout();
		if (tab.error) deps.send("browser:error", tab.error);
		sync(tab);
		enterActive();
		report(tab);
	}

	async function setActive(id) {
		const t = tabOf(id);
		if (!t) return { ok: false, reason: "unknown tab" };
		if (list.activeId === id) return { ok: true, ...snapshot(id) };
		const g = gen;
		await cancelPick();
		await leaveActive();
		if (g !== gen || switching) return SWITCHING;
		L.activate(list, id);
		becameActive(t);
		return { ok: true, ...snapshot(id) };
	}

	// A top-level move across sessions: reuse a tab on the same site in the other session, else a new tab. Makes it the active tab.
	async function moveTo(address) {
		if (switching) return SWITCHING;
		const a = accept(address);
		if (!a.ok) return a;
		const reuse = L.reusable(list, a.url);
		if (reuse) {
			await setActive(reuse.id);
			load(reuse, a.url);
			return { ok: true, tabId: reuse.id, ...snapshot(reuse.id) };
		}
		return createTab(a.url);
	}

	async function createTab(address) {
		const a = accept(address == null || address === "" ? deps.devUrl : address);
		if (!a.ok) return a;
		if (list.tabs.length >= L.MAX_TABS) return { ok: false, reason: "limit" };
		if (switching) return SWITCHING;
		const g = gen;
		await cancelPick();
		await leaveActive();
		if (g !== gen || switching) return SWITCHING; // the project changed while this waited: the tab would belong to the old one
		const r = makeTab(a.session, a.url);
		if (!r.ok) return { ok: false, reason: r.reason };
		becameActive(r.tab);
		return { ok: true, tabId: r.tab.id, ...snapshot(r.tab.id) };
	}

	async function closeTab(id) {
		const t = tabOf(id);
		if (!t) return { ok: false, reason: "unknown tab" };
		if (pickTab && (pickTab === t || isActive(t))) await cancelPick();
		if (isActive(t)) await leaveActive();
		const view = views.get(id);
		reload.drop(id);
		const r = L.close(list, id);
		views.delete(id);
		if (view) {
			try { deps.getWin()?.contentView.removeChildView(view); } catch { /* window gone */ }
			try { if (!view.webContents.isDestroyed()) view.webContents.close(); } catch { /* already gone */ }
		}
		if (r.empty) {
			const n = makeTab("web", deps.devUrl);
			becameActive(n.tab);
			return { ok: true, replaced: true, ...snapshot(n.tab.id) };
		}
		if (r.wasActive) becameActive(activeTab());
		else report(activeTab());
		return { ok: true, replaced: false, ...snapshot(list.activeId) };
	}

	// The address bar: acts on the active tab. A move across sessions opens in the other session (moveTo).
	async function navigate(address) {
		const t = activeTab();
		if (!t) return { ok: false, reason: "no tab" };
		let u = String(address || "").trim();
		if (!u) return { ok: false, reason: "empty" };
		// What the bar does with typed text (viewer-open-logic.js checkTyped): a web address as before (no scheme: https://); text with no
		// scheme that names an existing project file of a kind the Viewer shows opens that file; everything else is refused with a short
		// reason in `message` (file: and other schemes, a path outside the project, a dot folder, ...).
		const typed = logic.checkTyped(deps.getRoot(), u);
		if (typed.refuse) return { ok: false, reason: "refused", message: typed.refuse };
		if (typed.file) return openTyped(t, protocol.toAddress(deps.getRoot(), typed.file.path));
		u = typed.web;
		if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) u = `https://${u}`;
		const a = accept(u); // no file:// or other schemes in the Viewer
		if (!a.ok) return { ...a, message: VO.R.unknown };
		if (a.session !== t.session) return moveTo(a.url);
		load(t, a.url);
		return { ok: true, tabId: t.id };
	}
	const sameAddress = (x, y) => {
		try { return new URL(x).href === new URL(y).href; } catch { return x === y; }
	};
	// The tab that already shows this very file (not just a page of the same project).
	const showing = (address) => list.tabs.find((t) => sameAddress(t.address, address)) || null;
	// A project file typed in the bar: the tab that shows it is switched to; else a project tab loads it in place, as a typed address would;
	// else (the active tab is a web page, another session) a new tab.
	async function openTyped(t, address) {
		const a = accept(address);
		if (!a.ok) return { ok: false, reason: "refused", message: VO.R.invalid };
		const same = showing(a.url);
		if (same && same.id !== t.id) {
			await setActive(same.id);
			return { ok: true, tabId: same.id, reused: true };
		}
		if (L.isProjectSession(t.session)) {
			load(t, a.url);
			return { ok: true, tabId: t.id };
		}
		return openFile(a.url);
	}
	// The tree, the Editor and a dropped file (viewer-open-main.js has checked the path): switch to the tab that already shows the file, else
	// open a new tab. At the limit nothing opens and the reason is in `message`.
	async function openFile(address) {
		if (switching) return SWITCHING;
		const a = accept(address);
		if (!a.ok || !L.isProjectSession(a.session)) return { ok: false, reason: "refused", message: VO.R.invalid };
		const same = showing(a.url);
		if (same) {
			await setActive(same.id);
			return { ok: true, tabId: same.id, reused: true };
		}
		const r = await createTab(a.url);
		return r.ok ? r : { ok: false, reason: r.reason, message: r.reason === "limit" ? VO.R.limit : VO.R.invalid };
	}

	// Pages the APP opens (a story in Design, the Mendix bar, a localhost link clicked in a chat; spec section B "Where pages go", task 14):
	// one rule. A tab that already shows the site (same scheme, host and port) loads the address and becomes the active tab; else a new
	// tab opens; at the limit with no tab on the site nothing is replaced and the reason shows in the Viewer's reason line (a notice to the
	// UI, for callers that have no place to show it). The address bar keeps its own rule (navigate: the active tab).
	async function openSite(address) {
		if (switching) return SWITCHING;
		const a = accept(address);
		if (!a.ok || a.session !== "web") return { ok: false, reason: "refused", message: VO.R.unknown };
		const same = brk === "site-new" ? null : L.sameSite(list, a.url);
		if (same) {
			load(same, a.url); // before the switch, so the tab reports the new address at once
			await setActive(same.id);
			return { ok: true, tabId: same.id, reused: true };
		}
		if (list.tabs.length >= L.MAX_TABS && brk === "site-limit") {
			// selftest only: the deliberate break (the active tab is replaced at the limit)
			const t = activeTab();
			load(t, a.url);
			return { ok: true, tabId: t.id, reused: true };
		}
		const r = await createTab(a.url);
		if (r.ok) return { ok: true, tabId: r.tabId, reused: false };
		const message = r.reason === "limit" ? VO.R.limit : VO.R.invalid;
		deps.send("browser:notice", { message });
		return { ok: false, reason: r.reason, message };
	}

	// The agent's tool show_in_viewer (viewer-agent-main.js has checked the address): the page opens in a NEW tab in the BACKGROUND, or the tab
	// that already shows it is marked as updated. The active tab does not change, nothing takes focus, nothing is saved as the active tab.
	// allowNew false: only an existing tab may be used (the per-turn rate limit). At the limit nothing opens: `message` is the reason.
	//   break agent-focus (selftest): the page becomes the active tab. agent-reuse: an existing tab is not reused. agent-limit: at the limit
	//   the active tab is replaced.
	async function openBackground(address, { allowNew = true } = {}) {
		if (switching) return SWITCHING;
		const a = accept(address);
		if (!a.ok) return { ok: false, reason: "refused", message: VO.R.invalid };
		const same = brk === "agent-reuse" ? null : showing(a.url);
		if (same) {
			const active = isActive(same);
			if (!active) {
				same.updated = true;
				report(same);
			}
			return { ok: true, tabId: same.id, reused: true, active };
		}
		if (!allowNew) return { ok: false, reason: "rate" };
		if (list.tabs.length >= L.MAX_TABS) {
			if (brk === "agent-limit") {
				const t = activeTab();
				load(t, a.url);
				return { ok: true, tabId: t.id, reused: true, active: true };
			}
			return { ok: false, reason: "limit", message: VO.R.limit };
		}
		const r = makeTab(a.session, a.url, { activate: false });
		if (!r.ok) return { ok: false, reason: r.reason, message: r.reason === "limit" ? VO.R.limit : VO.R.invalid };
		r.tab.updated = true;
		deps.relayout(); // the new view starts hidden: only the active tab is ever visible
		if (brk === "agent-focus") {
			await setActive(r.tab.id);
			return { ok: true, tabId: r.tab.id, reused: false, active: true };
		}
		report(r.tab);
		return { ok: true, tabId: r.tab.id, reused: false, active: false };
	}
	// The tab that shows this address (the chat's tool card): made the active tab. false when it is gone.
	async function activateShowing(address) {
		const a = accept(address);
		const t = a.ok ? showing(a.url) : null;
		if (!t) return { ok: false };
		await setActive(t.id);
		return { ok: true, tabId: t.id };
	}

	function action(name) {
		const wc = wcOf(activeTab());
		if (!wc) return;
		if (name === "back" && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
		if (name === "forward" && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
		if (name === "reload") {
			if (activeTab().missing) recheckMissing(activeTab());
			else wc.reload();
		}
		if (name === "devtools") wc.toggleDevTools();
		if (name === "external") {
			const x = externalTarget();
			if (!x) return;
			lastExternal = x;
			if (deps.selftest) return; // a test never opens anything on the machine
			if (x.url) deps.shell.openExternal(x.url);
			else deps.shell.openPath(x.file).catch(() => {});
		}
	}
	// "Open in system browser" works for every kind of tab: a web address opens in the browser; a file of the project (page, image, PDF) opens
	// with the system's own program for it (the real path, found by the same rules as every request: never outside the project).
	let lastExternal = null;
	function externalTarget() {
		const t = activeTab();
		const wc = wcOf(t);
		if (!t || !wc) return null;
		const url = wc.getURL();
		if (/^https?:\/\//i.test(url)) return { url };
		if (!L.isProjectSession(t.session)) return null;
		let u;
		try { u = new URL(url); } catch { return null; }
		if (protocol.fromAddress(deps.getRoot(), url) == null) return null;
		const r = files.resolve(deps.getRoot(), u.pathname, "GET");
		return r && r.ok && files.kindOf(r.file) !== "other" ? { file: r.file } : null;
	}

	async function pick(repo, opts) {
		const t = activeTab();
		const view = activeView();
		if (!t || !view) return t && t.error ? { error: K.reason(t.kind, "pick", K.brokenOf(t.error)) } : { cancelled: true };
		const broken = K.brokenOf(t.error); // it still holds the old page in its hidden view: nothing to work on
		if (!K.can(t.kind, "pick", broken)) return { error: K.reason(t.kind, "pick", broken) };
		pickTab = t;
		let toggled = false;
		try {
			const r = await require("./picker").togglePick(view, repo, opts || {});
			toggled = !!(r && r.toggled);
			return r;
		} finally {
			if (!toggled && pickTab === t) pickTab = null;
			if (!pickTab && t.stale && isActive(t) && list.tabs.includes(t)) reloadTab(t); // a change that came in during the pick
		}
	}

	// The active tab, for the features: its address, kind and session.
	const activeInfo = () => {
		const t = activeTab();
		return t ? { id: t.id, address: t.address, kind: t.kind, session: t.session, error: !!t.error, broken: K.brokenOf(t.error) } : null;
	};
	// How to open an offscreen window on an address with the session that address belongs to (a web address: the web session; an address
	// of the open project: that project's own session). null when the Viewer would not open it.
	function captureTarget(address) {
		const a = accept(address);
		if (!a.ok) return null;
		if (a.session === "web") return { session: "web", kind: "page", webPreferences: { partition: WEB_PARTITION, sandbox: true, contextIsolation: true } };
		protocol.ensureSession(deps.getRoot());
		const p = protocol.fromAddress(deps.getRoot(), a.url);
		return { session: a.session, kind: p == null ? "page" : files.kindOf(p), webPreferences: protocol.viewerWebPreferences(deps.getRoot()) };
	}

	// --- window-level state, applied to every tab -------------------------------------------------------------------------------
	// rect: window pixels; visible: whether the Viewer may show at all. Only the active tab is ever visible.
	function layout(rect, visible) {
		for (const tab of list.tabs) {
			const view = views.get(tab.id);
			if (!view) continue;
			view.setBounds(rect);
			const show = visible && isActive(tab);
			// A view that gets hidden while it has keyboard focus would swallow keystrokes meant for the app: hand focus back.
			const hadFocus = !show && view.getVisible() && view.webContents.isFocused();
			view.setVisible(show);
			if (hadFocus) deps.getWin()?.webContents.focus();
		}
	}
	function setBackground(color) {
		bg = color;
		for (const view of views.values()) view.setBackgroundColor(color);
		for (const tab of list.tabs) if (tab.kind === "image") paintImage(tab).catch(() => {});
	}
	function setZoom(level) {
		for (const view of views.values()) view.webContents.setZoomLevel(level);
	}

	// --- remembered tabs (settings.json, per project; src/viewer-tabs-store.js) ----------------------------------------------------
	// Saved a moment after any change (report), when the project changes and when the app quits (flush). Nothing is saved while a project
	// switch rebuilds the list, and a list that is just the first-run tab on the dev address stores nothing (and clears an old entry).
	let saveTimer = null;
	let held = false;
	function persist() {
		clearTimeout(saveTimer);
		saveTimer = null;
		const root = deps.getRoot();
		if (held || !deps.store || !root || !list.tabs.length) return;
		if (deps.breakMode === "tabs-forget") return; // selftest only: the deliberate break (nothing is remembered)
		try {
			deps.store.write(root, S.isDefault(list, deps.devUrl) ? null : S.toStored(list, { root, protocol }));
		} catch { /* a settings file that cannot be written must not break the Viewer */ }
	}
	function scheduleSave() {
		if (held || !deps.store) return;
		clearTimeout(saveTimer);
		saveTimer = setTimeout(persist, 500);
		if (saveTimer.unref) saveTimer.unref();
	}
	// The project is about to change (call BEFORE the root changes): the old project's tabs are saved and closed. A late request from
	// one of those pages gets 404 (the address handler checks the project).
	function projectWillChange() {
		switching = true;
		gen++;
		persist();
		if (!deps.getRoot() || !list.tabs.length) return;
		cancelPick().catch(() => {});
		leaveActive().catch(() => {});
		destroyAll();
		held = true;
	}
	// The project has changed (call AFTER the root changed): its remembered tabs come back in order; only the active one loads now.
	// Nothing remembered: one tab on the dev address, as on a first run.
	function projectChanged() {
		const root = deps.getRoot();
		let stored = null;
		try { stored = deps.store && root ? S.fromStored(deps.store.read(root), { root, protocol, files }) : null; } catch { stored = null; }
		held = true;
		gen++;
		try {
			if (stored) {
				destroyAll();
				let activeId = null;
				stored.tabs.forEach((t, i) => {
					const r = makeTab(t.session, t.address, { lazy: true, title: t.title, missing: t.missing, unloaded: t.unloaded });
					if (r.ok && i === stored.active) activeId = r.tab.id;
				});
				if (activeId) L.activate(list, activeId);
				else if (list.tabs.length) L.activate(list, list.tabs[0].id);
				becameActive(activeTab());
			} else if (!list.tabs.length) {
				becameActive(makeTab("web", deps.devUrl).tab);
			}
		} finally {
			held = false;
			switching = false;
		}
		scheduleSave();
	}

	function init() {
		destroyAll();
		const r = makeTab("web", deps.devUrl);
		return r.tab;
	}
	function destroyAll() {
		reload.dropAll();
		for (const [id, view] of [...views]) {
			views.delete(id);
			try { deps.getWin()?.contentView.removeChildView(view); } catch { /* gone */ }
			try { if (!view.webContents.isDestroyed()) view.webContents.close(); } catch { /* gone */ }
		}
		list.tabs.length = 0;
		list.activeId = null;
		pickTab = null;
	}

	function register(ipcMain) {
		ipcMain.handle("browser:tabs", () => ({ tabs: list.tabs.map(publicTab), activeId: list.activeId }));
		ipcMain.handle("browser:tabCreate", (_e, address) => createTab(address));
		ipcMain.handle("browser:tabActivate", (_e, id) => setActive(String(id)));
		ipcMain.handle("browser:tabClose", (_e, id) => closeTab(String(id)));
		ipcMain.handle("browser:imageZoom", (_e, mode) => setImageZoom(mode));
		ipcMain.handle("browser:tabLoad", (_e, id) => loadTab(String(id)));
	}

	return {
		MAX_TABS: L.MAX_TABS,
		init,
		register,
		activeView,
		activeWc: () => wcOf(activeTab()),
		list: () => ({ tabs: list.tabs.map(publicTab), activeId: list.activeId }),
		create: createTab,
		activate: setActive,
		loadTab,
		close: closeTab,
		navigate,
		openFile,
		openSite,
		openBackground,
		activateShowing,
		requestSeen,
		// For the selftest and the tests: how many folders are watched, per tab the files it watches and how often it was reloaded by a change.
		reloadStats: () => ({ watchers: reload.count(), tabs: list.tabs.map((t) => ({ id: t.id, address: t.address, session: t.session, stale: !!t.stale, missing: !!t.missing, reloads: t.reloads || 0, files: reload.filesOf(t.id) })) }),
		action,
		pick,
		cancelPick,
		layout,
		setBackground,
		setZoom,
		reloadActive: () => action("reload"),
		onLeave: (fn) => leaveFns.push(fn),
		onEnter: (fn) => enterFns.push(fn),
		activeInfo,
		externalTarget,
		lastExternal: () => lastExternal,
		captureTarget,
		setImageZoom,
		activeError: () => (activeTab() ? !!activeTab().error : false),
		viewOf: (id) => views.get(id),
		destroyAll,
		projectWillChange,
		projectChanged,
		flush: persist,
	};
}

module.exports = { create, WEB_PARTITION };
