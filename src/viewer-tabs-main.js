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
// Annotate, snapshots, Stories and Mendix keep working unchanged. What must still be reset per tab when the active tab changes (left to
// task 6, feature side): browser-tools-main.js (CDP debugger attachment, forced states, the target selector, the emulated colour scheme
// stay on the tab they were set on), design-main.js (Tweak CSS inserted into the old tab is never removed there), annotate.js (hides the
// active view only), snap-main.js (the offscreen capture window hard-codes persist:devbrowser), design-stories.js and mendix.js (they
// keep one browserUrl, not one per tab), and renderer.js (one address bar, one error box, one #browser-slot; the state event already
// carries tabId, tabs and activeId, the UI ignores them until task 5). Done here: a running pick is cancelled on a switch.
const L = require("./viewer-tabs-list");
const pp = require("./project-protocol");
const pf = require("./project-files");

const WEB_PARTITION = "persist:devbrowser";

// deps: { WebContentsView, nativeTheme, getWin, send, isLocal, isWin, devUrl, getRoot, getZoomLevel, relayout, setErrorHidden,
//         breakMode (selftest only), files, protocol }
function create(deps) {
	const files = deps.files || pf;
	const protocol = deps.protocol || pp;
	const list = L.create();
	const views = new Map(); // tab id -> WebContentsView
	let webSessionReady = false;
	let bg = deps.nativeTheme.shouldUseDarkColors ? "#1b1b1b" : "#eef0f0";
	let pickTab = null; // the tab a running pick is on

	const tabOf = (id) => L.find(list, id);
	const activeTab = () => L.active(list);
	const activeView = () => (activeTab() ? views.get(activeTab().id) : undefined);
	const wcOf = (tab) => (tab && views.get(tab.id) ? views.get(tab.id).webContents : null);
	const isActive = (tab) => !!tab && list.activeId === tab.id;

	const publicTab = (t) => ({ id: t.id, session: t.session, kind: t.kind, address: t.address, title: t.title, loading: t.loading, canGoBack: t.canGoBack, canGoForward: t.canGoForward, error: t.error });
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
	const report = (tab) => deps.send("browser:state", snapshot(tab ? tab.id : null));

	function sync(tab) {
		const wc = wcOf(tab);
		if (!wc || wc.isDestroyed()) return;
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
				(mod && (["k", "1", "2", "3", "4", "5", "j", "n", "o", "[", "]", "{", "}", "c"].includes(k) ? !input.alt : k === "b" || (k === "f" && input.shift && !input.alt))) ||
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
		if (web) {
			// Only the active tab's events reach the browser tools: a background tab's navigation must not reset the active tab's target.
			const filtered = { on: (ev, fn) => wc.on(ev, (...a) => isActive(tab) && fn(...a)) };
			require("./browser-tools-main").attach?.(filtered);
		}
		return view;
	}

	function load(tab, address) {
		const wc = wcOf(tab);
		tab.address = address;
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

	function makeTab(session, address, { activate = true } = {}) {
		const r = L.add(list, { session, address, title: "", loading: false, canGoBack: false, canGoForward: false, error: null, kind: "page" }, { activate });
		if (!r.ok) return r;
		buildView(r.tab);
		load(r.tab, address);
		return r;
	}

	function becameActive(tab) {
		deps.setErrorHidden(!!tab.error);
		deps.relayout();
		if (tab.error) deps.send("browser:error", tab.error);
		sync(tab);
		report(tab);
	}

	async function setActive(id) {
		const t = tabOf(id);
		if (!t) return { ok: false, reason: "unknown tab" };
		if (list.activeId === id) return { ok: true, ...snapshot(id) };
		await cancelPick();
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
		const r = makeTab(a.session, a.url);
		if (!r.ok) return { ok: false, reason: r.reason };
		becameActive(r.tab);
		return { ok: true, tabId: r.tab.id, ...snapshot(r.tab.id) };
	}

	async function closeTab(id) {
		const t = tabOf(id);
		if (!t) return { ok: false, reason: "unknown tab" };
		if (pickTab && (pickTab === t || isActive(t))) await cancelPick();
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
		if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) u = `https://${u}`;
		const a = accept(u); // no file:// or other schemes in the Viewer
		if (!a.ok) return a;
		if (a.session !== t.session) return moveTo(a.url);
		load(t, a.url);
		return { ok: true, tabId: t.id };
	}

	function action(name) {
		const wc = wcOf(activeTab());
		if (!wc) return;
		if (name === "back" && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
		if (name === "forward" && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
		if (name === "reload") wc.reload();
		if (name === "devtools") wc.toggleDevTools();
		if (name === "external") {
			const url = wc.getURL();
			if (/^https?:\/\//i.test(url)) deps.shell.openExternal(url);
		}
	}

	async function pick(repo, opts) {
		const t = activeTab();
		const view = activeView();
		if (!t || !view) return { cancelled: true };
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
	}
	function setZoom(level) {
		for (const view of views.values()) view.webContents.setZoomLevel(level);
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
		action,
		pick,
		cancelPick,
		layout,
		setBackground,
		setZoom,
		reloadActive: () => action("reload"),
		activeError: () => (activeTab() ? !!activeTab().error : false),
		viewOf: (id) => views.get(id),
		destroyAll,
	};
}

module.exports = { create, WEB_PARTITION };
