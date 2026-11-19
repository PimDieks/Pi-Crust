// Self-test step `viewer-tabs`: the main-process tab model of the Viewer (src/viewer-tabs-main.js), driven through the IPC only
// (crust.browser.tabs / createTab / activateTab / closeTab / navigate / pick). The main side (viewer-tabs-selftest-main.js) starts a loopback
// web server and a throwaway project and reports each tab's real session. Run: npm run selftest -- viewer-tabs
// Negative control: PI_CRUST_SELFTEST_VIEWER_BREAK=tabs-pick (a switch no longer cancels a running pick): the step must report MISMATCH.
"use strict";

selftestSteps.push(async () => {
	const checks = [];
	const check = (name, ok, detail) => {
		checks.push({ name, ok: !!ok });
		console.error(`SELFTEST viewer-tabs ${name}: ${ok ? "OK" : "MISMATCH" + (detail === undefined ? "" : " (" + String(detail).slice(0, 300) + ")")}`);
	};
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	const B = crust.browser;
	const T = (op) => crust.selftest.viewerTabs(op);
	const events = [];
	B.onState((s) => events.push(s));
	const list = async () => B.tabs();
	const ids = (l) => l.tabs.map((t) => t.id);
	const byId = (l, id) => l.tabs.find((t) => t.id === id);
	const settled = async (id) => {
		for (let i = 0; i < 80; i++) {
			const t = byId(await list(), id);
			if (t && !t.loading && t.address) return t;
			await sleep(100);
		}
		return byId(await list(), id);
	};
	let S;
	try {
		S = await T("start");
		// A restart run (scripts/viewer-tabs-restart.js, two launches with one data folder) runs only the remembered-tabs checks.
		run: {
		if (S.phase) {
			await window.viewerTabsStoreChecks({ S, check, sleep, list, byId, ids, phase: S.phase });
			break run;
		}
		const web = `http://127.0.0.1:${S.port}/`;
		const webOther = `http://localhost:${S.port}/`; // the same server, another site

		// --- start: one tab on the dev address ---------------------------------------------------------------------------------
		let l = await list();
		check("starts with one web tab on the dev address", l.tabs.length === 1 && l.tabs[0].session === "web" && l.activeId === l.tabs[0].id && l.tabs[0].address.startsWith(S.devUrl.replace(/\/$/, "")), JSON.stringify(l));
		const first = l.tabs[0].id;

		// --- create, order, activate -------------------------------------------------------------------------------------------
		let r = await B.createTab(web);
		const w1 = r.tabId;
		check("create: a web tab, active, right of the first", r.ok && w1 && r.activeId === w1 && JSON.stringify(ids(r)) === JSON.stringify([first, w1]), JSON.stringify(r));
		r = await B.createTab(S.page);
		const p1 = r.tabId;
		l = await list();
		check("create: a project tab, active, right of the active one", r.ok && l.activeId === p1 && JSON.stringify(ids(l)) === JSON.stringify([first, w1, p1]) && byId(l, p1).session.startsWith("project:"), JSON.stringify(l));
		await settled(w1);
		await settled(p1);
		let pr = await T("probe");
		const pw = pr.tabs.find((t) => t.id === w1);
		const pp1 = pr.tabs.find((t) => t.id === p1);
		check("sessions: web tab on persist:devbrowser, project tab on persist:viewer-project-<label>", pw.isWebSession && !pw.isProjectSession && pp1.isProjectSession && !pp1.isWebSession, JSON.stringify(pr.tabs));
		check("a project tab has the kind of its file (page)", byId(await list(), p1).kind === "page");
		check("a web tab shows its page title", byId(await list(), w1).title === "web page", byId(await list(), w1).title);

		r = await B.createTab(S.image);
		const i1 = r.tabId;
		r = await B.createTab(S.pdf);
		const d1 = r.tabId;
		await settled(i1);
		await settled(d1);
		l = await list();
		check("project tabs: image and pdf kinds", byId(l, i1).kind === "image" && byId(l, d1).kind === "pdf", JSON.stringify([byId(l, i1).kind, byId(l, d1).kind]));
		r = await B.createTab(S.missingKind);
		check("create refuses a project file the Viewer does not show", !r.ok, JSON.stringify(r));
		r = await B.createTab(S.otherProject);
		check("create refuses another project's address", !r.ok, JSON.stringify(r));
		r = await B.createTab("file:///C:/Users/alex/x.html");
		check("create refuses a file address", !r.ok, JSON.stringify(r));
		check("refused creates leave the list alone", (await list()).tabs.length === 5);

		// --- unknown ids -------------------------------------------------------------------------------------------------------
		const before = JSON.stringify(await list());
		const ra = await B.activateTab("nope");
		const rc = await B.closeTab("nope");
		check("activate and close refuse an unknown id", !ra.ok && !rc.ok && JSON.stringify(await list()) === before, JSON.stringify([ra, rc]));

		// --- activate, ctx.browserView follows ---------------------------------------------------------------------------------
		let follows = true;
		let oneVisible = true;
		for (const id of [first, w1, p1, i1, d1, w1]) {
			const a = await B.activateTab(id);
			pr = await T("probe");
			if (!a.ok || a.activeId !== id || !pr.ctxViewIsActive || !pr.tabs.find((t) => t.id === id).isCtxView || pr.tabs.filter((t) => t.isCtxView).length !== 1) follows = false;
			if (pr.tabs.some((t) => t.visible && t.id !== id)) oneVisible = false;
		}
		check("ctx.browserView follows the active tab", follows, JSON.stringify(pr));
		check("only the active tab is ever visible", oneVisible, JSON.stringify(pr));

		// --- the state event: tab id and the full list --------------------------------------------------------------------------
		await sleep(300);
		const last = events[events.length - 1];
		check("the state event carries the tab id and the full list", !!last && typeof last.tabId === "string" && last.tabs.length === 5 && last.activeId === w1 && last.tabs.some((t) => t.id === last.tabId), JSON.stringify(last && { tabId: last.tabId, n: last.tabs && last.tabs.length, activeId: last.activeId }));
		check("the top-level fields are the active tab's (the UI keeps working)", !!last && last.url === byId(await list(), w1).address, last && last.url);

		// --- cross-kind moves ---------------------------------------------------------------------------------------------------
		await B.activateTab(p1);
		const nBefore = (await list()).tabs.length;
		r = await B.navigate(webOther); // project page -> web address on a site no web tab has: a new web tab
		l = await list();
		const nw = byId(l, r.tabId);
		check("project to web address, no tab on that site: a new web tab, active", r.ok && nw && nw.session === "web" && l.activeId === nw.id && l.tabs.length === nBefore + 1, JSON.stringify(r));
		check("the project tab keeps its project page and session", byId(l, p1).session.startsWith("project:") && byId(l, p1).address === S.page, JSON.stringify(byId(l, p1)));
		await settled(nw.id);
		pr = await T("probe");
		check("the new tab for the web address is on the web session", pr.tabs.find((t) => t.id === nw.id).isWebSession, JSON.stringify(pr.tabs));
		await B.activateTab(p1);
		r = await B.navigate(web + "other"); // the project tab again: a web tab on that site exists (w1): reuse it
		l = await list();
		check("project to web address, a tab on that site: it is reused", r.ok && r.tabId === w1 && l.activeId === w1 && l.tabs.length === nBefore + 1, JSON.stringify(r));
		r = await B.navigate(S.image); // web tab -> project address: reuse the project tab on that project (the first in order)
		l = await list();
		check("web to project address, a project tab exists: it is reused and shows the file", r.ok && byId(l, r.tabId).session.startsWith("project:") && l.activeId === r.tabId && l.tabs.length === nBefore + 1, JSON.stringify(r));
		await settled(r.tabId);
		// close every project tab, then move from a web tab to a project address: a new project tab
		for (const t of (await list()).tabs.filter((x) => x.session.startsWith("project:"))) await B.closeTab(t.id);
		await B.activateTab(w1);
		const n2 = (await list()).tabs.length;
		r = await B.navigate(S.page);
		l = await list();
		const np = byId(l, r.tabId);
		check("web to project address, no project tab: a new project tab", r.ok && np && np.session.startsWith("project:") && l.activeId === np.id && l.tabs.length === n2 + 1, JSON.stringify(r));
		await settled(np.id);
		pr = await T("probe");
		check("that project tab is on the project session", pr.tabs.find((t) => t.id === np.id).isProjectSession && !pr.tabs.find((t) => t.id === np.id).isWebSession, JSON.stringify(pr.tabs));
		r = await B.navigate("file:///C:/Users/alex/x.html");
		check("the address bar still refuses a file address", !r.ok);

		// --- the limit ---------------------------------------------------------------------------------------------------------
		while ((await list()).tabs.length < 8) await B.createTab(web);
		r = await B.createTab(web);
		check("the limit: a ninth tab is refused with a reason", !r.ok && r.reason === "limit" && (await list()).tabs.length === 8, JSON.stringify(r));
		await B.activateTab(np.id);
		r = await B.navigate("https://example.invalid/");
		check("the limit: a move that needs a new tab is refused too", !r.ok && (await list()).tabs.length === 8, JSON.stringify(r));

		// --- a pick is cancelled by a switch -------------------------------------------------------------------------------------
		await B.closeTab((await list()).tabs.find((t) => t.session === "web" && t.id !== w1).id); // make room, keep it simple
		l = await list();
		const webs = l.tabs.filter((t) => t.session === "web");
		const [pa, pb] = [webs[0].id, webs[1].id];
		await B.activateTab(pa);
		await settled(pa);
		const t0 = Date.now();
		const pickP = B.pick({});
		await sleep(600);
		await B.activateTab(pb);
		const res = await Promise.race([pickP, sleep(4000).then(() => "still running")]);
		check("a switch cancels a running pick", res && res.cancelled === true && Date.now() - t0 < 4000, JSON.stringify(res));

		// --- close ---------------------------------------------------------------------------------------------------------------
		l = await list();
		const act = l.activeId;
		const idx = ids(l).indexOf(act);
		const expectNext = l.tabs[idx + 1] ? l.tabs[idx + 1].id : l.tabs[idx - 1].id;
		r = await B.closeTab(act);
		check("closing the active tab activates its right neighbour (else left)", r.ok && r.activeId === expectNext && !byId(await list(), act), JSON.stringify(r.activeId));
		pr = await T("probe");
		check("after a close ctx.browserView is the new active tab's view", pr.ctxViewIsActive);
		while ((await list()).tabs.length > 1) await B.closeTab((await list()).tabs[0].id);
		l = await list();
		const lastId = l.tabs[0].id;
		r = await B.closeTab(lastId);
		l = await list();
		check("closing the last tab replaces it by one on the dev address", r.ok && r.replaced === true && l.tabs.length === 1 && l.tabs[0].id !== lastId && l.tabs[0].session === "web" && l.tabs[0].address.startsWith(S.devUrl.replace(/\/$/, "")), JSON.stringify(l));
		pr = await T("probe");
		check("and ctx.browserView is that new tab's view", pr.ctxViewIsActive && pr.tabs.length === 1);

		// --- the row of page tabs (src/viewer-tab-row.js; checks in viewer-tabs-selftest-row.js) ----------------------------------------
		await window.viewerTabsRowChecks({ S, check, sleep, list, byId, ids });
		// --- the active tab in view, Fit and 100% in the toolbar, the reason line, the fade (viewer-tabs-selftest-active.js) ---------------
		await window.viewerTabsActiveChecks({ S, check, sleep, list, byId, ids });
		// --- remembered tabs: shape, project switch and back, a first run with nothing stored (viewer-tabs-selftest-store.js) ----------
		await window.viewerTabsStoreChecks({ S, check, sleep, list, byId, ids, phase: "" });
		}
	} catch (e) {
		check("no exception", false, e && e.stack ? e.stack : e);
	} finally {
		await T("stop").catch(() => {});
	}
	const bad = checks.filter((c) => !c.ok).length;
	console.error(`SELFTEST viewer-tabs: ${checks.length} checks, ${bad ? bad + " MISMATCH" : "all OK"}`);
}, "viewer-tabs");
