// Self-test, the Viewer's remembered tabs (spec: Viewer tabs and project files, section B "Remembered", section C "Deleted or switched", task 7).
// Called by the `viewer-tabs` step (viewer-tabs-selftest.js) with the step's helpers, in three ways:
//   phase ""        a normal run: what is stored (its exact shape), a project switch and back, a first run with nothing stored, lazy loading.
//   phase "save"    launch 1 of scripts/viewer-tabs-restart.js: build the tabs of a project that outlives the run; the app's own quit saves them.
//   phase "restore" launch 2, same data folder, after the runner removed one project file and added tampered entries to settings.json:
//                   the tabs are back in order, only the active one is loaded, the missing file is a tab with its message, the tampered
//                   entries are gone.
// Deliberate break: PI_CRUST_SELFTEST_VIEWER_BREAK=tabs-forget (nothing is remembered): the step must report MISMATCH.
"use strict";

window.viewerTabsStoreChecks = async function viewerTabsStoreChecks({ S, check, sleep, list, byId, phase }) {
	const B = crust.browser;
	const T = (op) => crust.selftest.viewerTabs(op);
	const web = `http://127.0.0.1:${S.port}/`;
	const storedOf = async (root) => (await T({ op: "stored", root })).entry;
	const probe = async () => (await T("probe")).tabs;
	const until = async (fn, ms = 6000) => {
		for (let t = 0; t < ms; t += 100) {
			if (await fn()) return true;
			await sleep(100);
		}
		return !!(await fn());
	};
	const settled = async (id) => {
		await until(async () => {
			const t = byId(await list(), id);
			return t && !t.loading && t.address;
		}, 8000);
		return byId(await list(), id);
	};
	const storable = (t) => t.session.startsWith("project:") || /^https?:\/\//i.test(t.address || "");
	const pathOf = (a) => decodeURIComponent(new URL(a).pathname).replace(/^\/+/, "");
	const entryKey = (x) => Object.keys(x).sort().join();
	const shapeOk = (e) =>
		!!e && typeof e === "object" && Object.keys(e).sort().join() === "active,tabs" && Array.isArray(e.tabs) && Number.isInteger(e.active) && e.active >= 0 && e.active < e.tabs.length &&
		e.tabs.every((x) => (entryKey(x) === "address,title" || entryKey(x) === "path,title") && typeof x.title === "string");
	// What the live list would be saved as.
	const expectedOf = (l) => {
		const tabs = l.tabs.filter(storable);
		return { places: tabs.map((t) => (t.session.startsWith("project:") ? pathOf(t.address) : t.address)), active: Math.max(0, tabs.findIndex((t) => t.id === l.activeId)) };
	};
	const placesOf = (e) => e.tabs.map((x) => x.path || x.address);
	const reset = async () => {
		while ((await list()).tabs.length > 1) await B.closeTab((await list()).tabs[0].id);
	};
	const mk = async (a) => (await B.createTab(a)).tabId;
	let pr;
	// Colour maths (WCAG) for the contrast check: computed colours come as rgb(), rgba() or color(srgb ...).
	const chan = (str) => {
		const n = (String(str).match(/-?\d*\.?\d+(?:e-?\d+)?/g) || []).map(Number);
		const unit = /^color\(/.test(String(str)) ? 255 : 1;
		return [n[0] * unit, n[1] * unit, n[2] * unit];
	};
	const lum = (c) => {
		const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
		return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
	};
	const ratio = (fg, bg) => {
		const [a, b] = [lum(chan(fg)), lum(chan(bg))].sort((x, y) => y - x);
		return (a + 0.05) / (b + 0.05);
	};
	const shot = async (name, suffix = "v2", each) => {
		for (const th of ["light", "dark"]) {
			setTheme(th);
			await sleep(700);
			if (each) each(th);
			await crust.selftest.capture(`${name}-${th}-${suffix}`);
		}
		setTheme("light");
	};

	switchTab("browser");
	await sleep(500);

	// =================================================================================================================================
	if (phase === "save") {
		// Launch 1: the dev tab, a web page, a project page, an image, a PDF and a file that the runner removes before launch 2.
		const w = await mk(web);
		const pg = await mk(S.page);
		const im = await mk(S.image);
		const pf = await mk(S.pdf);
		const gone = await mk(S.root ? S.page.replace("a.html", "gone.html") : "");
		for (const id of [w, pg, im, pf, gone]) await settled(id);
		await B.activateTab(im);
		await settled(im);
		await sleep(300);
		await T("flush");
		const l = await list();
		const e = await storedOf(S.root);
		check("save: six tabs, the image tab active", l.tabs.length === 6 && l.activeId === im, JSON.stringify(l.tabs.map((t) => t.address)));
		check("save: what is stored has the exact shape { tabs: [{ address | path, title }], active } and nothing else", shapeOk(e), JSON.stringify(e));
		const ex = expectedOf(l);
		check("save: it is the open tabs in order (addresses of web pages, project paths of files) and the active one", !!e && JSON.stringify(placesOf(e)) === JSON.stringify(ex.places) && e.active === ex.active && e.tabs.some((x) => x.path === "a.html") && e.tabs.some((x) => x.path === "gone.html"), JSON.stringify(e));
		check("save: the stored titles are the page titles", !!e && e.tabs.find((x) => x.path === "a.html").title === "project page" && e.tabs.find((x) => x.path === "gone.html").title === "soon gone" && e.tabs.find((x) => x.address === web).title === "web page", JSON.stringify(e));
		// A change right before the end: only the app's quit (or the short delay) can save it.
		await B.activateTab(pf);
		await settled(pf);
		await B.activateTab(im);
		await settled(im);
		return;
	}

	// =================================================================================================================================
	if (phase === "restore") {
		await sleep(800); // the restored list is rebuilt by the project opening; give the first (active) page time to load
		const l = await list();
		const places = l.tabs.map((t) => (t.session.startsWith("project:") ? pathOf(t.address) : t.address));
		check("restore: the six stored tabs are back, in the stored order (dev address, web page, a.html, pic.png, doc.pdf, gone.html), then the planted address", l.tabs.length === 7 && places[0].replace(/\/$/, "") === S.devUrl.replace(/\/$/, "") && /^http:\/\/127\.0\.0\.1:\d+\/$/.test(places[1]) && JSON.stringify(places.slice(2, 6)) === JSON.stringify(["a.html", "pic.png", "doc.pdf", "gone.html"]) && places[6] === "https://planted.invalid/login", JSON.stringify(places));
		const planted = l.tabs[6];
		check("restore: a planted web address (not local) is an unloaded tab with its address and no page; the one with a password is gone", !!planted && planted.error && planted.error.unloaded === true && planted.error.url === "https://planted.invalid/login" && !l.tabs.some((t) => /secret|user:/.test(t.address)), JSON.stringify(planted));
		const act = byId(l, l.activeId);
		const im = l.tabs[3];
		check("restore: the active tab is the one that was active (the image)", !!act && act.id === im.id && pathOf(act.address) === "pic.png" && act.kind === "image", JSON.stringify(act));
		check("restore: titles come back with the tabs (web page, project page, soon gone)", l.tabs[1].title === "web page" && l.tabs[2].title === "project page" && l.tabs[5].title === "soon gone", JSON.stringify(l.tabs.map((t) => t.title)));
		check("restore: kinds are known before the tabs are shown (page, image, pdf)", l.tabs[2].kind === "page" && l.tabs[3].kind === "image" && l.tabs[4].kind === "pdf", JSON.stringify(l.tabs.map((t) => t.kind)));
		// Lazy: only the active tab has a page.
		pr = await probe();
		const withView = pr.filter((t) => t.hasView).map((t) => t.id);
		check("lazy: only the active tab has a view and has loaded; the others load when first shown", withView.length === 1 && withView[0] === im.id && /pic\.png$/.test(pr.find((t) => t.id === im.id).wcUrl) && pr.filter((t) => t.id !== im.id).every((t) => !t.hasView && t.wcUrl === ""), JSON.stringify(pr.map((t) => [t.hasView, t.wcUrl])));
		// Tampered entries are gone.
		const bad = l.tabs.filter((t) => /^file:|^javascript:|\.\.|^chrome|^data:/i.test(t.address) || (t.session.startsWith("project:") && !t.address.startsWith(S.page.replace(/\/a\.html$/, "/"))));
		check("tampered: a file: address, another project's address, a path with .., a dot folder, javascript:, a type the Viewer does not show and entries without an address are all dropped", bad.length === 0 && l.tabs.length === 7, JSON.stringify(bad.map((t) => t.address)));
		await until(async () => { const e = await storedOf(S.root); return e && e.tabs.length === 7; }, 4000);
		const e = await storedOf(S.root);
		check("tampered: and what is stored afterwards is clean again (the same six and the planted address, the same active tab)", shapeOk(e) && e.tabs.length === 7 && e.active === 3 && e.tabs.every((x) => !("address" in x) || /^https?:/.test(x.address)), JSON.stringify(e));
		await shot("vt-restored");
		// The file that is gone.
		const gone = l.tabs[5];
		check("missing file: its tab is there (not dropped), marked as failed, with its stored title", !!gone && pathOf(gone.address) === "gone.html" && !!gone.error && gone.error.desc === "This file no longer exists", JSON.stringify(gone));
		await B.activateTab(gone.id);
		await until(() => !$("#browser-error").hidden);
		const box = $("#browser-error").textContent;
		check("missing file: showing it says \"This file no longer exists\" and where it was (no error code, no page load)", /This file no longer exists/.test(box) && /gone\.html/.test(box) && !/Can't load/.test(box), box);
		check("missing file: the tab row marks it as failed", [...document.querySelectorAll("#vt-list .vt-item.failed")].length === 1);
		pr = await probe();
		check("missing file: nothing was loaded for it", pr.find((t) => t.id === gone.id).wcUrl === "", JSON.stringify(pr.find((t) => t.id === gone.id)));
		await B.action("reload");
		await sleep(400);
		check("missing file: Reload looks again and it is still gone, the message stays", byId(await list(), gone.id).error && !$("#browser-error").hidden && /no longer exists/.test($("#browser-error").textContent));
		await shot("vt-restored-gone");
		// The unloaded notice: the address wraps instead of overflowing and shows the host clearly.
		await B.activateTab(planted.id);
		await until(() => !!document.querySelector("#browser-error .unloaded-address"));
		const addrEl = document.querySelector("#browser-error .unloaded-address");
		const hostEl = addrEl.querySelector(".host");
		check("unloaded notice: the stored address in full, the host on its own in full strength and the rest dimmer, wrapping, and a Load button", addrEl.textContent === "https://planted.invalid/login" && !!hostEl && hostEl.textContent === "planted.invalid" && getComputedStyle(addrEl).overflowWrap === "anywhere" && Number(getComputedStyle(addrEl.querySelector(".rest")).opacity) < 1 && Number(getComputedStyle(hostEl).opacity) === 1 && /Load/.test($("#browser-error button").textContent), addrEl.textContent);
		await shot("vt-unloaded", "v3", (th) => {
			const lb = $("#browser-error button");
			const cs = getComputedStyle(lb);
			const r = ratio(cs.color, cs.backgroundColor);
			check("unloaded notice: the Load button is the app's filled button (not the plain grey one), 4.5:1 or better, not faded, in " + th, lb.classList.contains("btn") && cs.backgroundColor !== "rgba(0, 0, 0, 0)" && r >= 4.5 && Number(cs.opacity) === 1 && !lb.disabled, `${r.toFixed(2)}:1 ${cs.color} on ${cs.backgroundColor}`);
		});
		// Showing another tab loads it then.
		const pdfTab = l.tabs[4];
		await B.activateTab(pdfTab.id);
		await settled(pdfTab.id);
		pr = await probe();
		check("lazy: a tab is loaded when first shown (the PDF now has a view and its page)", pr.find((t) => t.id === pdfTab.id).hasView && /doc\.pdf$/.test(pr.find((t) => t.id === pdfTab.id).wcUrl) && !pr.find((t) => t.id === l.tabs[2].id).hasView, JSON.stringify(pr.map((t) => [t.hasView, t.wcUrl])));
		await B.activateTab(l.tabs[2].id);
		await settled(l.tabs[2].id);
		check("lazy: the project page is shown and loaded when first shown", /a\.html$/.test((await probe()).find((t) => t.id === l.tabs[2].id).wcUrl));
		return;
	}

	// =================================================================================================================================
	// A normal run. A first run with nothing stored: a project that was never opened has one tab on the dev address and nothing is written.
	const pC = S.tmp.split("\\").join("/") + "/projC";
	await T({ op: "project", root: pC, make: true });
	await sleep(500);
	const first = await list();
	check("first run: nothing stored gives one tab on the dev address", first.tabs.length === 1 && first.tabs[0].session === "web" && first.tabs[0].address.startsWith(S.devUrl.replace(/\/$/, "")), JSON.stringify(first.tabs.map((t) => t.address)));
	await sleep(700);
	await T("flush");
	check("first run: and nothing is written for the project", (await storedOf(pC)) === null);
	await T({ op: "project", root: S.root });
	await sleep(500);
	await reset();

	// Build tabs in project A, save, look at the exact shape.
	const wA = await mk(web);
	const pgA = await mk(S.page);
	const imA = await mk(S.image);
	const pfA = await mk(S.pdf);
	for (const id of [wA, pgA, imA, pfA]) await settled(id);
	await B.activateTab(imA);
	await settled(imA);
	await T("flush");
	const lA = await list();
	const eA = await storedOf(S.root);
	const exA = expectedOf(lA);
	check("stored: the exact shape { tabs: [{ address | path, title }], active }, nothing else (no history, no scroll, no content)", shapeOk(eA), JSON.stringify(eA));
	check("stored: a web page by its address, a project file by its project path, the active tab by its index", !!eA && JSON.stringify(placesOf(eA)) === JSON.stringify(exA.places) && eA.active === exA.active && eA.tabs.some((x) => x.path === "a.html" && x.title === "project page") && eA.tabs.some((x) => x.path === "pic.png") && eA.tabs.some((x) => x.path === "doc.pdf") && eA.tabs.some((x) => x.address === web && x.title === "web page"), JSON.stringify(eA));
	const settingsFile = (await T({ op: "stored", root: S.root })).file;
	check("stored: it sits under settings.json \"viewerTabs\", keyed by the project (like figmaFiles) and no other key was added", /"viewerTabs"/.test(settingsFile) && Object.keys(JSON.parse(settingsFile)).filter((k) => !["zoomLevel", "viewerTabs"].includes(k)).length === 0, Object.keys(JSON.parse(settingsFile)).join());
	const before = JSON.stringify(eA);

	// Project switch: the old project's tabs are saved and closed, the new one has the first-run state.
	const B2 = S.tmp.replace(/\\/g, "/") + "/projB";
	const pB = await T({ op: "project", root: B2, make: true });
	await sleep(500);
	let lB = await list();
	pr = await probe();
	check("switch: the old project's tabs are closed and the new project (nothing stored) has one tab on the dev address", lB.tabs.length === 1 && lB.tabs[0].session === "web" && lB.tabs[0].address.startsWith(S.devUrl.replace(/\/$/, "")) && pr.length === 1, JSON.stringify(lB.tabs.map((t) => t.address)));
	check("switch: the old project's entry is kept as it was", JSON.stringify(await storedOf(S.root)) === before, JSON.stringify(await storedOf(S.root)));
	const late = await T({ op: "lateFetch", root: S.root, file: "a.html" });
	check("switch: a late request for the old project's page gets 404 (never served)", late.serve === 404 && late.fetch !== 200, JSON.stringify(late));
	const pgB = await mk(pB.page2);
	const imB = await mk(pB.image);
	await settled(pgB);
	await settled(imB);
	await T("flush");
	const eB = await storedOf(B2);
	check("switch: the new project's tabs are saved under the new project, not the old one", shapeOk(eB) && JSON.stringify(placesOf(eB).filter((p) => !/^https?:/.test(p))) === JSON.stringify(["b.html", "pic.png"]) && JSON.stringify(await storedOf(S.root)) === before, JSON.stringify(eB));

	// ... and back.
	await T({ op: "project", root: S.root });
	await sleep(600);
	const lBack = await list();
	pr = await probe();
	const placesBack = lBack.tabs.map((t) => (t.session.startsWith("project:") ? pathOf(t.address) : t.address));
	check("back: the first project's tabs are back in order with the same active tab and none of the other project's", JSON.stringify(placesBack) === JSON.stringify(exA.places) && lBack.tabs.findIndex((t) => t.id === lBack.activeId) === exA.active && !lBack.tabs.some((t) => /projB|b\.html/.test(t.address)), JSON.stringify(placesBack));
	check("back: titles come back with the tabs", lBack.tabs.some((t) => t.title === "project page") && lBack.tabs.some((t) => t.title === "web page"), JSON.stringify(lBack.tabs.map((t) => t.title)));
	const act = lBack.activeId;
	check("lazy: only the active tab is loaded after the restore", pr.filter((t) => t.hasView).length === 1 && pr.find((t) => t.hasView).id === act && pr.filter((t) => t.id !== act).every((t) => !t.hasView && t.wcUrl === ""), JSON.stringify(pr.map((t) => [t.hasView, t.wcUrl])));
	const other = lBack.tabs.find((t) => t.id !== act && /a\.html$/.test(t.address));
	await B.activateTab(other.id);
	await settled(other.id);
	pr = await probe();
	check("lazy: a tab loads when it is first shown", pr.find((t) => t.id === other.id).hasView && /a\.html$/.test(pr.find((t) => t.id === other.id).wcUrl), JSON.stringify(pr.find((t) => t.id === other.id)));
	const lateB = await T({ op: "lateFetch", root: B2, file: "b.html" });
	check("back: now a late request for the second project's page gets 404", lateB.serve === 404 && lateB.fetch !== 200, JSON.stringify(lateB));

	// A tab list that is back to the first-run state clears the entry.
	await T("flush");
	const beforeA = JSON.stringify(await storedOf(S.root));
	await T({ op: "project", root: B2 });
	await sleep(500);
	await reset();
	await B.closeTab((await list()).tabs[0].id); // the last tab is replaced by one on the dev address
	await sleep(300);
	await T("flush");
	// (the list for B was restored: two files; closing them all leaves the dev tab)
	check("a project back to the first-run state (one tab on the dev address) stores nothing: its entry is cleared", (await storedOf(B2)) === null && JSON.stringify(await storedOf(S.root)) === beforeA, JSON.stringify(await storedOf(B2)));
	await T({ op: "project", root: S.root });
	await sleep(500);
	await reset();
};
