// Self-test step `viewer-reload`: live reload of project files in the Viewer (src/viewer-reload.js, viewer-tabs-main.js) and where pages
// the app opens go (task 14: a story, the Mendix bar, a chat link). Everything runs through the real tabs, the real address handler and real
// files on disk; the main side (viewer-reload-selftest-main.js) builds a throwaway project, writes, deletes and renames its files, and counts
// hits on two loopback web servers. Run: npm run selftest -- viewer-reload
// Groups: save (one reload, ten quick saves one reload, loading state), dep (stylesheet, script, image, a page that does not use it),
// background (stale, reloads once when shown), web (never), delete (delete, restore, rename), storm (300 files at once), focus and scroll, pick,
// watchers (closed with the tab and on a project switch, bounded lists), rule (story, Mendix, chat link: same-site tab, new tab, the limit).
// Deliberate breaks, each of which must make the step report MISMATCH (PI_CRUST_SELFTEST_VIEWER_BREAK=<name>):
//   reload-storm  no pause (save)        reload-deps  files a page loaded are not watched (dep)   reload-any  any file in the folder counts (dep)
//   reload-bg     a background tab reloads at once (background)    reload-web  a change reloads web tabs too (web)
//   reload-delete a deleted file shows nothing (delete)            reload-leak  watchers stay open (watchers)
//   site-new      the rule never reuses a tab (rule)               site-limit  at 8 tabs the active tab is replaced (rule)
"use strict";

selftestSteps.push(async () => {
	const checks = [];
	const check = (name, ok, detail) => {
		checks.push({ name, ok: !!ok });
		console.error(`SELFTEST viewer-reload ${name}: ${ok ? "OK" : "MISMATCH" + (detail === undefined ? "" : " (" + String(detail).slice(0, 400) + ")")}`);
	};
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	const until = async (fn, ms = 4000) => {
		for (let t = 0; t < ms; t += 50) {
			if (await fn()) return true;
			await sleep(50);
		}
		return !!(await fn());
	};
	const B = crust.browser;
	const T = (op, extra = {}) => crust.selftest.viewerReload({ op, ...extra });
	const LIMIT = "8 pages is the most. Close one first.";
	const stats = () => T("stats");
	const tabStat = async (id) => (await stats()).tabs.find((t) => t.id === id) || null;
	const tabInfo = async (id) => (await B.tabs()).tabs.find((t) => t.id === id) || null;
	const reloadsOf = async (id) => (await tabStat(id))?.reloads ?? -1;
	const loadsOf = async (id) => +(/:(\d+)\|/.exec((await tabInfo(id))?.title || "") || [])[1] || 0;
	const titleHas = (id, text) => async () => ((await tabInfo(id))?.title || "").includes(text);
	const base = (p) => p.split(/[\\/]/).pop();
	const write = (rel, data) => T("write", { rel, data });
	const reset = async () => {
		while ((await B.tabs()).tabs.length > 1) await B.closeTab((await B.tabs()).tabs[0].id);
		$("#vt-reason").textContent = "";
	};
	const openRel = async (rel) => {
		const r = await B.openFile({ rel });
		return r && r.ok ? r.tabId : null;
	};
	let S;
	try {
		S = await T("start");
		console.error(`SELFTEST viewer-reload break: ${S.brk || "(none)"}`);
		const root = S.root;

		// --- save ---------------------------------------------------------------------------------------------------------------
		const P = await openRel("page.html");
		check("save open", !!P && (await until(titleHas(P, "page:1|rgb(10, 20, 30)|v1"))), JSON.stringify(await tabInfo(P)));
		check("save watch list", await until(async () => {
			const f = ((await tabStat(P))?.files || []).map(base).sort().join(",");
			return f === "app.js,page.html,pic.png,style.css";
		}), JSON.stringify((await tabStat(P))?.files));
		const st0 = await tabStat(P);
		check("save watch list inside the project only", st0.files.every((f) => f.toLowerCase().startsWith(root.toLowerCase())), JSON.stringify(st0.files));
		let sawLoading = false;
		const off = B.onState((s) => { if ((s.tabs || []).some((t) => t.id === P && t.loading)) sawLoading = true; });
		await write("page.html", "<!doctype html><meta charset=utf-8><title>page</title><link rel=stylesheet href=style.css><script src=app.js defer></script><body><img src=pic.png width=4 height=4><div style='height:5000px'>tall</div><script>var n=1;try{n=(+sessionStorage.getItem('n')||0)+1;sessionStorage.setItem('n',n)}catch(e){}addEventListener('load',function(){document.title='page:'+n+'|'+getComputedStyle(document.body).backgroundColor+'|'+(window.__v||'-')})</script>");
		check("save one reload", await until(async () => (await reloadsOf(P)) >= 1));
		await sleep(900);
		check("save exactly one", (await reloadsOf(P)) === 1 && (await loadsOf(P)) === 2, `reloads ${await reloadsOf(P)} loads ${await loadsOf(P)}`);
		check("save loading state shows", sawLoading);
		if (typeof off === "function") off();
		const r1 = await reloadsOf(P);
		for (let i = 1; i <= 10; i++) { await write("app.js", `window.__v='q${i}'`); await sleep(15); }
		await sleep(1200);
		check("save ten quick saves give one reload", (await reloadsOf(P)) === r1 + 1, `reloads ${await reloadsOf(P)} (was ${r1})`);
		check("save the last save is what shows", await until(titleHas(P, "|q10")), (await tabInfo(P))?.title);
		check("save watchers are per folder", (await stats()).watchers === 1, (await stats()).watchers);

		// --- dep (stylesheet, script, image; a page that does not use it) --------------------------------------------------------------
		let r = await reloadsOf(P);
		await write("style.css", "body{background:rgb(40,50,60)}");
		check("dep stylesheet reloads the page that uses it", (await until(titleHas(P, "rgb(40, 50, 60)"))) && (await reloadsOf(P)) === r + 1, `${(await tabInfo(P))?.title} reloads ${await reloadsOf(P)}`);
		r = await reloadsOf(P);
		await write("app.js", "window.__v='v2'");
		check("dep script reloads it", (await until(titleHas(P, "|v2"))) && (await reloadsOf(P)) === r + 1, (await tabInfo(P))?.title);
		r = await reloadsOf(P);
		await write("pic.png", "not really a png");
		check("dep image reloads it", await until(async () => (await reloadsOf(P)) === r + 1));
		await sleep(600);
		check("dep image: once", (await reloadsOf(P)) === r + 1);

		const O = await openRel("other.html"); // a page with no stylesheet, script or image: now the active tab; P is in the background
		check("dep other page opens", !!O && (await until(titleHas(O, "other:1|rgb(1, 2, 3)"))), JSON.stringify(await tabInfo(O)));
		check("dep other page watches its own file only", (await until(async () => ((await tabStat(O))?.files || []).map(base).join(",") === "other.html")), JSON.stringify((await tabStat(O))?.files));
		r = await reloadsOf(P);
		const lP = await loadsOf(P);
		await write("style.css", "body{background:rgb(70,80,90)}");
		await sleep(1000);
		const o1 = await tabStat(O);
		check("dep the page that does not use the stylesheet does not reload (and is not stale)", o1.reloads === 0 && !o1.stale && (await loadsOf(O)) === 1, JSON.stringify(o1));

		// --- background ---------------------------------------------------------------------------------------------------------------
		const p1 = await tabStat(P);
		check("background tab does not reload, it is marked stale", p1.reloads === r && p1.stale && (await loadsOf(P)) === lP, JSON.stringify({ reloads: p1.reloads, was: r, stale: p1.stale, loads: await loadsOf(P), lP }));
		const loadsBefore = lP;
		await sleep(600);
		check("background tab still has not loaded", (await loadsOf(P)) === loadsBefore && (await reloadsOf(P)) === r);
		await B.activateTab(P);
		check("background tab reloads when it is shown", await until(titleHas(P, "rgb(70, 80, 90)")), (await tabInfo(P))?.title);
		await sleep(700);
		const p2 = await tabStat(P);
		check("background tab reloads once, and is no longer stale", p2.reloads === r + 1 && !p2.stale && (await loadsOf(P)) === loadsBefore + 1, JSON.stringify({ reloads: p2.reloads, stale: p2.stale, loads: await loadsOf(P), loadsBefore }));

		// --- web ------------------------------------------------------------------------------------------------------------------------
		const W = (await B.createTab(`http://127.0.0.1:${S.portA}/`)).tabId;
		check("web tab opens", !!W && (await until(titleHas(W, "web A"))), JSON.stringify(await tabInfo(W)));
		await sleep(300);
		const hitsA = (await stats()).hits.A;
		await write("style.css", "body{background:rgb(5,5,5)}");
		await write("app.js", "window.__v='v3'");
		await sleep(1200);
		const w1 = await tabStat(W);
		check("web tab is never reloaded by a file change", (await stats()).hits.A === hitsA && w1.reloads === 0, `hits ${(await stats()).hits.A} was ${hitsA}, reloads ${w1.reloads}`);
		await B.activateTab(P);
		await B.closeTab(W);
		check("web tab closed", !(await tabInfo(W)));
		check("web: the project tab that was in the background loads once it is shown", await until(titleHas(P, "rgb(5, 5, 5)|v3")), (await tabInfo(P))?.title);
		await sleep(600);

		// --- delete ---------------------------------------------------------------------------------------------------------------------
		const D = await openRel("del.html");
		check("delete open", !!D && (await until(titleHas(D, "del:1"))), JSON.stringify(await tabInfo(D)));
		const errBox = () => $("#browser-error");
		await T("del", { rel: "del.html" });
		check("delete shows the message with the path", await until(() => !errBox().hidden && /This file no longer exists/.test(errBox().textContent) && /del\.html/.test(errBox().textContent)), errBox().textContent);
		check("delete tab is marked", (await tabStat(D))?.missing === true);
		await write("del.html", "<!doctype html><meta charset=utf-8><title>del</title><body><p>back</p><script>addEventListener('load',function(){document.title='del:back'})</script>");
		check("restore loads it again", (await until(titleHas(D, "del:back"))) && errBox().hidden, `${(await tabInfo(D))?.title} hidden=${errBox().hidden}`);
		check("restore tab is no longer marked", (await tabStat(D))?.missing === false);
		await T("rename", { from: "del.html", to: "del-moved.html" });
		check("rename counts as deleted", await until(() => !errBox().hidden && /This file no longer exists/.test(errBox().textContent)), errBox().textContent);
		await T("rename", { from: "del-moved.html", to: "del.html" });
		check("rename back loads it again", (await until(titleHas(D, "del:back"))) && (await until(() => errBox().hidden)), `${(await tabInfo(D))?.title} hidden=${errBox().hidden}`);
		await B.closeTab(D);
		await B.activateTab(P);

		// --- storm ----------------------------------------------------------------------------------------------------------------------
		await sleep(500);
		r = await reloadsOf(P);
		await T("storm", { n: 300, dir: "." });
		await sleep(1200);
		check("storm: 300 other files in the folder give no reload", (await reloadsOf(P)) === r, `reloads ${await reloadsOf(P)} was ${r}`);
		await T("storm", { n: 300, dir: ".", touch: "style.css", data: "body{background:rgb(11,22,33)}" });
		check("storm: a build that also changes the stylesheet gives one reload", (await until(titleHas(P, "rgb(11, 22, 33)"))) && ((await sleep(900)), (await reloadsOf(P)) === r + 1), `reloads ${await reloadsOf(P)} was ${r}`);

		// --- focus and scroll ---------------------------------------------------------------------------------------------------------------
		await T("eval", { code: "window.scrollTo(0, 700)" });
		await sleep(200);
		const y0 = (await T("eval", { code: "window.scrollY" })).value;
		const input = $("#input");
		input.focus();
		r = await reloadsOf(P);
		await write("style.css", "body{background:rgb(12,23,34)}");
		check("focus: reload happened", (await until(titleHas(P, "rgb(12, 23, 34)"))) && (await reloadsOf(P)) === r + 1);
		await sleep(500);
		const fc = await T("viewFocused");
		check("focus: the chat input keeps focus, the page does not take it", document.activeElement === input && !fc.focused, `active=${document.activeElement?.id} viewFocused=${fc.focused}`);
		const y1 = (await T("eval", { code: "window.scrollY" })).value;
		check("scroll position is kept", y0 >= 600 && Math.abs(y1 - y0) <= 2, `before ${y0} after ${y1}`);
		input.blur();

		// --- pick -----------------------------------------------------------------------------------------------------------------------
		// A reload cuts the picker's page script off (the toolbar's Reload does today: the pick fails). A change that arrives during a pick
		// therefore waits: the tab is marked stale and reloads once the pick ends.
		r = await reloadsOf(P);
		const pk = B.pick({});
		await sleep(500);
		await write("style.css", "body{background:rgb(13,24,35)}");
		await sleep(1000);
		const mid = await tabStat(P);
		check("pick: a change during a pick does not reload; the tab waits", mid.reloads === r && mid.stale, JSON.stringify({ reloads: mid.reloads, was: r, stale: mid.stale }));
		await B.pick(); // the second press cancels the running pick
		const pr = await Promise.race([pk, sleep(3000).then(() => "timeout")]);
		check("pick: the pick ended as cancelled, not as an error", pr && pr.cancelled === true && !pr.error, JSON.stringify(pr));
		check("pick: the waiting change reloads once the pick is over", (await until(titleHas(P, "rgb(13, 24, 35)"))) && (await reloadsOf(P)) === r + 1, `${(await tabInfo(P))?.title} reloads ${await reloadsOf(P)}`);

		// --- watchers: navigation resets the list, the list is bounded ---------------------------------------------------------------------------
		const nav = await B.navigate("page2.html"); // typed project path: this project tab loads it in place
		check("watchers: a typed path loads in the tab", !!nav && nav.ok !== false && (await until(titleHas(P, "page2:"))), JSON.stringify(nav));
		check("watchers: the list restarts at the new page", await until(async () => { const f = ((await tabStat(P))?.files || []).map(base); return f.includes("page2.html") && !f.includes("page.html") && f.length === 4; }), JSON.stringify((await tabStat(P))?.files));
		let many = "<!doctype html><title>many</title>";
		await T("storm", { n: 100, dir: "imgs" });
		for (let i = 0; i < 100; i++) many += `<script src="imgs/chunk-${i}.js"></script>`;
		await write("many.html", many);
		await B.navigate("many.html");
		check("watchers: a page that loads 100 files is bounded to 64", await until(async () => ((await tabStat(P))?.files || []).length === 64), `${((await tabStat(P))?.files || []).length}`);
		await B.navigate("page.html");
		await until(titleHas(P, "page:"));

		// --- watchers: closed with the tab, closed on a project switch --------------------------------------------------------------------------
		const wOpen = (await stats()).watchers;
		check("watchers: open while a project tab is open", wOpen >= 1, wOpen);
		await B.closeTab(O);
		await B.closeTab(P);
		check("watchers: none left after the last project tab is closed", await until(async () => (await stats()).watchers === 0), (await stats()).watchers);
		const P2 = await openRel("page.html");
		await until(async () => (await stats()).watchers >= 1);
		check("watchers: open again for a new tab", (await stats()).watchers >= 1 && !!P2);
		await T("root", { which: 2 });
		check("watchers: none left after a project switch", await until(async () => (await stats()).watchers === 0), (await stats()).watchers);
		check("watchers: the old project's tabs are gone", !(await tabInfo(P2)));
		await T("root", { which: 1 });
		await reset();

		// --- rule: a story, the Mendix bar and a chat link ---------------------------------------------------------------------------------
		const S1 = `http://127.0.0.1:${S.portA}`;
		const S2 = `http://127.0.0.1:${S.portB}`;
		const entries = [
			["story", (u) => B.openSite(u)],
			["mendix", (u) => B.openSite(u)],
			["chat", async (u) => { window.open(u, "_blank"); await sleep(500); }], // the chat's link: main's window-open handler (openLink)
		];
		for (const [name, open] of entries) {
			await reset();
			const t0 = (await B.tabs()).tabs;
			await open(`${S1}/${name}-1`);
			await until(async () => (await B.tabs()).tabs.length === t0.length + 1);
			let l = await B.tabs();
			const sTab = l.tabs.find((t) => t.address.startsWith(S1));
			check(`rule ${name}: no tab on the site opens a new one, active`, l.tabs.length === t0.length + 1 && !!sTab && l.activeId === sTab.id, JSON.stringify(l.tabs.map((t) => t.address)));
			await B.activateTab(t0[0].id);
			await open(`${S1}/${name}-2`);
			await until(async () => (await B.tabs()).activeId === sTab?.id);
			l = await B.tabs();
			await until(async () => ((await tabInfo(sTab.id))?.address || "").endsWith(`${name}-2`));
			const after = await tabInfo(sTab.id);
			check(`rule ${name}: a tab on the site loads it and becomes active`, l.tabs.length === t0.length + 1 && l.activeId === sTab.id && (after?.address || "").endsWith(`${name}-2`), JSON.stringify({ n: l.tabs.length, active: l.activeId, sTab: sTab.id, address: after?.address }));
			await open(`${S2}/${name}`);
			await until(async () => (await B.tabs()).tabs.length === t0.length + 2);
			l = await B.tabs();
			check(`rule ${name}: another port is another site, a new tab`, l.tabs.length === t0.length + 2 && l.tabs.find((t) => t.id === l.activeId).address.startsWith(S2), JSON.stringify(l.tabs.map((t) => t.address)));
			// to the limit with fake sites (nothing listens: the pages fail to load, which is fine here)
			for (let k = 2; (await B.tabs()).tabs.length < 8; k++) await B.createTab(`http://127.0.0.1:${k}/`);
			l = await B.tabs();
			const before = l.tabs.map((t) => t.id + "=" + t.address).join("|");
			$("#vt-reason").textContent = "";
			$("#vt-reason").classList.remove("show");
			await open(`http://127.0.0.1:9/${name}`);
			await sleep(600);
			l = await B.tabs();
			check(`rule ${name}: at 8 tabs with no tab on the site nothing is replaced`, l.tabs.length === 8 && l.tabs.map((t) => t.id + "=" + t.address).join("|") === before, JSON.stringify(l.tabs.map((t) => t.address)));
			check(`rule ${name}: the reason shows in the reason line`, $("#vt-reason").textContent === LIMIT && $("#vt-reason").classList.contains("show"), $("#vt-reason").textContent);
			await open(`${S1}/${name}-3`);
			await sleep(600);
			l = await B.tabs();
			const again = l.tabs.find((t) => t.id === sTab.id);
			check(`rule ${name}: at 8 tabs a tab on the site is still reused`, l.tabs.length === 8 && l.activeId === sTab.id && (again?.address || "").endsWith(`${name}-3`), JSON.stringify({ n: l.tabs.length, active: l.activeId, address: again?.address }));
		}
		await reset();
	} catch (e) {
		check("no exception", false, e && e.stack ? e.stack : e);
	} finally {
		await reset().catch(() => {});
		await T("stop").catch(() => {});
	}
	const bad = checks.filter((c) => !c.ok).length;
	console.error(`SELFTEST viewer-reload: ${checks.length} checks, ${bad ? bad + " MISMATCH" : "all OK"}`);
}, "viewer-reload");
