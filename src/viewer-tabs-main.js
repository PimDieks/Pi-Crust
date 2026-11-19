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

const WEB_PARTITION = "persist:devbrowser";

// deps: { WebContentsView, nativeTheme, getWin, send, isLocal, isWin, devUrl, getRoot, getZoomLevel, relayout, setErrorHidden,
//         breakMode (selftest only), files, protocol,
//         store: { read(root), write(root, value | null) } (the remembered tabs, in settings.json) }
function create(deps) {
	const files = deps.files || pf;
	const protocol = deps.protocol || pp;
	const list = L.create();
	const logic = VO.create({ files, protocol, breakMode: deps.selftest ? deps.breakMode : "" });
	const views = new Map(); // tab id -> WebContentsView
	let webSessionReady = false;
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

	const publicTab = (t) => ({ id: t.id, session: t.session, kind: t.kind, zoom: t.zoom || "fit", address: t.address, title: t.title, loading: t.loading, canGoBack: t.canGoBack, canGoForward: t.canGoForward, error: t.error });
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
				(mod && (["k", "1", "2", "3", "4", "5", "j", "n", "o", "[", "]", "{", "}", "c", "t", "w"].includes(k) ? !input.alt : k === "b" || (k === "f" && input.shift && !input.alt))) ||
					(mod && input.alt && !input.shift && (k === "arrowleft" || k === "arrowright")) || // previous / next page
				(input.control && !input.meta && (input.code === "Backquote" || input.code === "Tab")) ||
				(["1", "2", "3"].includes(k) && input.control && (deps.isWin ? input.alt && !input.meta : input.meta && !input.alt)); // view switch
			if (appKey) {
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
		const guardMove = (event, url) => {
			const a = accept(url);
			const toProject = a.ok && L.isProjectSession(a.session);
			if (web ? !toProject : toProject && a.session === tab.session) return;
			event.preventDefault();
			if (a.ok) moveTo(a.url).catch(() => {});
		};
		wc.on("will-navigate", guardMove);
		wc.on("will-redirect", guardMove);
		// Only the active tab's events reach the browser tools: a background tab's navigation must not reset the active tab's target.
		const filtered = { on: (ev, fn) => wc.on(ev, (...a) => isActive(tab) && fn(...a)) };
		require("./browser-tools-main").attach?.(filtered);
		// An image tab: neutral background, shown fitted or at its real size (setImageZoom).
		wc.on("did-start-navigation", (d) => { if (d.isMainFrame && !d.isSameDocument) tab.imageKey = null; });
		wc.on("did-finish-load", () => { if (mine()) paintImage(tab).catch(() => {}); });
		return view;
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
	function makeTab(session, address, { activate = true, lazy = false, title = "", missing = false } = {}) {
		const r = L.add(list, { session, address, title, loading: false, canGoBack: false, canGoForward: false, error: null, kind: "page" }, { activate });
		if (!r.ok) return r;
		if (L.isProjectSession(session)) {
			const p = protocol.fromAddress(deps.getRoot(), address);
			r.tab.kind = p == null ? "page" : files.kindOf(p); // known before the first load, so the tools see it at once
		}
		if (lazy) {
			r.tab.lazy = true;
			if (missing) markMissing(r.tab);
			return r;
		}
		buildView(r.tab);
		load(r.tab, address);
		return r;
	}

	// --- a restored tab ----------------------------------------------------------------------------------------------------------
	const MISSING = "This file no longer exists";
	function markMissing(tab) {
		tab.missing = true;
		tab.error = { code: 404, desc: MISSING, url: tab.address, missing: true };
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
		if (!tab.lazy) return;
		tab.lazy = false;
		buildView(tab);
		if (fileGone(tab)) markMissing(tab);
		else {
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
		materialize(tab);
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
		await cancelPick();
		await leaveActive();
		L.activate(list, id);
		becameActive(t);
		return { ok: true, ...snapshot(id) };
	}

	// A top-level move across sessions: reuse a tab on the same site in the other session, else a new tab. Makes it the active tab.
	async function moveTo(address) {
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
		await cancelPick();
		await leaveActive();
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
		if (!t || !view) return { cancelled: true };
		if (!K.can(t.kind, "pick")) return { error: K.reason(t.kind, "pick") };
		pickTab = t;
		let toggled = false;
		try {
			const r = await require("./picker").togglePick(view, repo, opts || {});
			toggled = !!(r && r.toggled);
			return r;
		} finally {
			if (!toggled && pickTab === t) pickTab = null;
		}
	}

	// The active tab, for the features: its address, kind and session.
	const activeInfo = () => {
		const t = activeTab();
		return t ? { id: t.id, address: t.address, kind: t.kind, session: t.session, error: !!t.error } : null;
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
		try {
			if (stored) {
				destroyAll();
				let activeId = null;
				stored.tabs.forEach((t, i) => {
					const r = makeTab(t.session, t.address, { lazy: true, title: t.title, missing: t.missing });
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
		}
		scheduleSave();
	}

	function init() {
		destroyAll();
		const r = makeTab("web", deps.devUrl);
		return r.tab;
	}
	function destroyAll() {
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
		close: closeTab,
		navigate,
		openFile,
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
