// Self-test, the Viewer's tab row, round 2 (defects seen in the screenshots vt-kind-image-light, vt-kind-pdf-dark and vt-eight-limit-dark).
// Called by the `viewer-tabs` step (viewer-tabs-selftest.js) after the row checks, with the step's helpers. Each check here fails on the code
// of commit d325adc. Real DOM, real clicks and focus, real geometry:
//   1 the ACTIVE tab is always fully in view: after activating, after a tab is added or closed, when the row's width changes, while a reason shows;
//   2 "Fit" and "100%" are in the toolbar with the page tools, for an image tab only, not in the tab row;
//   3 the reason of a disabled tool: only while hovered or focused, at most half the row, wrapped never cut, never over a tab;
//   4 a scrolling list fades on the cut-off side(s);
//   5 the reason for a PDF reads "Needs a web page or an image. This tab shows a PDF." and obeys 3.
"use strict";

window.viewerTabsActiveChecks = async function viewerTabsActiveChecks({ S, check, sleep, list }) {
	const B = crust.browser;
	const R = window.crustViewerRow;
	const web = `http://127.0.0.1:${S.port}/`;
	const ROW = () => $("#viewer-tabs");
	const LIST = () => $("#vt-list");
	const rect = (n) => n.getBoundingClientRect();
	const until = async (fn, ms = 4000) => {
		for (let t = 0; t < ms; t += 50) {
			if (fn()) return true;
			await sleep(50);
		}
		return !!fn();
	};
	const PDF_REASON = "Needs a web page or an image. This tab shows a PDF.";
	const IMG_REASON = "Needs a web page. This tab shows an image.";
	const FADE = 24;

	// The tab is whole inside the list's visible part, clear of a fade on a side that has more, and nothing is drawn over it.
	const inView = (id) => {
		const e = R.items().get(id);
		if (!e || !e.item.offsetParent) return { ok: false, why: "no tab" };
		const l = LIST();
		const lr = rect(l);
		const ir = rect(e.item);
		const atStart = l.scrollLeft <= 1;
		const atEnd = l.scrollLeft >= l.scrollWidth - l.clientWidth - 1;
		const roomForFades = lr.width >= ir.width + 2 * FADE + 6; // in a very narrow list the tab is whole but may sit under a fade
		const left = ir.left >= lr.left + 2.5 && (atStart || !roomForFades || ir.left >= lr.left + FADE - 1);
		const right = ir.right <= lr.right - 2.5 && (atEnd || !roomForFades || ir.right <= lr.right - FADE + 1);
		const mid = document.elementFromPoint(ir.left + ir.width / 2, ir.top + ir.height / 2);
		const top = mid === e.item || e.item.contains(mid) || !ROW().contains(mid); // (something outside the row, as a panel of the window, is not the row's doing)
		return { ok: left && right && top, left, right, top, mid: mid && (mid.id || mid.className || mid.tagName), tab: [Math.round(ir.left), Math.round(ir.right)], list: [Math.round(lr.left), Math.round(lr.right)], scroll: Math.round(l.scrollLeft) };
	};
	const visibleTab = async (id, ms = 1500) => {
		await until(() => inView(id).ok, ms);
		return inView(id);
	};
	// A reason line (the toolbar tool's #vt-reason, or the + button's #vt-limit): at most half the row, inside it, not cut, not over the list.
	const reasonRules = (el, text) => {
		const r = rect(el);
		const row = rect(ROW());
		const cs = getComputedStyle(el);
		const shown = cs.visibility === "visible" && cs.display !== "none" && cs.opacity === "1" && el.textContent === text && r.width > 0;
		const half = r.width <= row.width / 2 + 0.5;
		const uncut = el.scrollWidth <= el.clientWidth + 1 && el.scrollHeight <= el.clientHeight + 1 && cs.overflow === "visible" && cs.textOverflow !== "ellipsis";
		const inside = r.top >= row.top - 0.5 && r.bottom <= row.bottom + 0.5 && r.left >= row.left - 0.5 && r.right <= row.right + 0.5;
		const clear = r.left >= rect($("#vt-add")).right - 0.5 || el === $("#vt-limit"); // never over the list (the limit line sits between list and +)
		const overList = r.left >= rect(LIST()).right - 3.5;
		return { ok: shown && half && uncut && inside && clear && overList, shown, half, uncut, inside, clear, overList, w: Math.round(r.width), h: Math.round(r.height), rowW: Math.round(row.width), sw: el.scrollWidth, cw: el.clientWidth, text: el.textContent };
	};

	await crust.selftest.focusEmulation(true);
	switchTab("browser");
	await sleep(400);
	while ((await list()).tabs.length > 1) await B.closeTab((await list()).tabs[0].id);
	await B.navigate(web);
	const mk = async (a) => (await B.createTab(a)).tabId;
	await mk(web);
	await mk(web);
	await mk(S.page);
	const img = await mk(S.image);
	const pdf = await mk(S.pdf);
	await mk(web);
	await mk(web);
	await until(() => R.state().tabs.length === 8 && !R.state().tabs.some((t) => t.loading), 8000);
	const sz = [innerWidth, innerHeight];
	await crust.selftest.resize(1100, sz[1]);
	await sleep(700);
	const tools = { tweak: $("#tweak-btn"), annotate: $("#annotate-btn") };

	// --- 1. the active tab is always in view --------------------------------------------------------------------------------------
	await B.activateTab(pdf);
	await until(() => R.state().activeId === pdf);
	check("active in view: after activating a tab (a PDF tab in a long row)", (await visibleTab(pdf)).ok, JSON.stringify(inView(pdf)));
	tools.annotate.focus();
	await until(() => getComputedStyle($("#vt-reason")).visibility === "visible");
	await sleep(300);
	const v1 = await visibleTab(pdf);
	check("active in view: while a reason shows at the right end of the row", v1.ok && $("#vt-reason").textContent === PDF_REASON, JSON.stringify(v1));
	tools.annotate.blur();
	await sleep(200);
	check("active in view: and after the reason is gone", (await visibleTab(pdf)).ok, JSON.stringify(inView(pdf)));
	// The same for every tab in turn, with the reason of the + showing at the limit.
	let all = true;
	let worst = "";
	for (const t of R.state().tabs) {
		await B.activateTab(t.id);
		await until(() => R.state().activeId === t.id);
		$("#vt-add").focus();
		await sleep(150);
		const v = await visibleTab(t.id);
		if (!v.ok) {
			all = false;
			worst = JSON.stringify(v);
		}
	}
	$("#vt-add").blur();
	check("active in view: each of the 8 tabs in turn, with the reason of + showing", all, worst);

	// 8 -> 6 tabs, then add and close beside the active one.
	await B.closeTab(R.state().tabs[7].id);
	await B.closeTab(R.state().tabs[6].id);
	await B.activateTab(img);
	await until(() => R.state().activeId === img);
	$("#vt-add").click();
	await until(() => R.state().tabs.length === 7);
	const added = R.state().activeId;
	check("active in view: after a tab is added (new tab right of the active one)", added !== img && (await visibleTab(added)).ok, JSON.stringify(inView(added)));
	await mk(web);
	await until(() => R.state().tabs.length === 8);
	const last = R.state().activeId;
	check("active in view: after a tab is added at the end of a full row", (await visibleTab(last)).ok, JSON.stringify(inView(last)));
	await B.closeTab(last);
	await until(() => R.state().tabs.length === 7);
	const afterClose = R.state().activeId;
	check("active in view: after the active tab is closed (its neighbour is active)", afterClose !== last && (await visibleTab(afterClose)).ok, JSON.stringify(inView(afterClose)));
	await B.activateTab(R.state().tabs[R.state().tabs.length - 1].id);
	await sleep(200);
	await crust.selftest.resize(1000, sz[1]);
	await sleep(700);
	const lastNarrow = R.state().activeId;
	check("active in view: when the row gets narrower (window 1000 px)", (await visibleTab(lastNarrow)).ok, JSON.stringify(inView(lastNarrow)));
	await B.activateTab(R.state().tabs[1].id);
	await sleep(200);
	await crust.selftest.resize(sz[0], sz[1]);
	await sleep(700);
	const second = R.state().activeId;
	check("active in view: when the row gets wider again (the window's own width)", (await visibleTab(second)).ok, JSON.stringify(inView(second)));
	await crust.selftest.resize(1100, sz[1]);
	await sleep(700);

	// --- 2. Fit and 100% are toolbar tools, for an image tab only ------------------------------------------------------------------
	const zoom = $("#vt-zoom");
	await B.activateTab(img);
	await until(() => !zoom.hidden);
	const bar = $(".browser-bar");
	const zr = rect(zoom);
	const br = rect(bar);
	check("Fit and 100%: in the toolbar row with the page tools, not in the tab row", zoom.closest(".browser-bar") === bar && !ROW().contains(zoom) && zr.top >= br.top - 0.5 && zr.bottom <= br.bottom + 0.5, JSON.stringify([zr, br].map((r) => [Math.round(r.top), Math.round(r.bottom)])));
	check("Fit and 100%: next to the tools that are disabled for an image (after Force state, before DevTools)", zr.left >= rect($("#state-btn")).right - 0.5 && zr.right <= rect($('[data-action="devtools"]')).left + 0.5, JSON.stringify([rect($("#state-btn")).right, zr.left, zr.right, rect($('[data-action="devtools"]')).left].map(Math.round)));
	check("Fit and 100%: both buttons are shown, with their names", [...zoom.querySelectorAll("button")].map((b) => b.textContent).join(",") === "Fit,100%" && !zoom.hidden && zr.width > 40);
	await B.activateTab(pdf);
	await until(() => zoom.hidden);
	check("Fit and 100%: hidden on a PDF tab", zoom.hidden && getComputedStyle(zoom).display === "none");
	await B.activateTab(R.state().tabs[0].id);
	await until(() => zoom.hidden);
	check("Fit and 100%: hidden on a web page", zoom.hidden && getComputedStyle(zoom).display === "none");

	// --- 3 and 5. the reason of a disabled tool ----------------------------------------------------------------------------------------
	const probes = [];
	for (const [id, tool, text] of [[pdf, "annotate", PDF_REASON], [pdf, "tweak", "Needs a web page. This tab shows a PDF."], [img, "tweak", IMG_REASON]]) {
		await B.activateTab(id);
		await until(() => R.state().activeId === id);
		for (const width of [1100, 1000]) {
			await crust.selftest.resize(width, sz[1]);
			await sleep(600);
			const node = tools[tool];
			// hover
			node.dispatchEvent(new MouseEvent("mouseenter"));
			await sleep(200);
			const h = reasonRules($("#vt-reason"), text);
			const hv = inView(id);
			await sleep(150);
			const bnd = await crust.selftest.bounds();
			const below = bnd.view.y >= rect(ROW()).bottom * bnd.z - 1.5;
			node.dispatchEvent(new MouseEvent("mouseleave"));
			await sleep(150);
			const gone1 = getComputedStyle($("#vt-reason")).visibility === "hidden" && $("#vt-reason").textContent === "";
			// focus
			node.focus();
			await sleep(200);
			const f = reasonRules($("#vt-reason"), text);
			const fv = await visibleTab(id);
			node.blur();
			await sleep(150);
			const gone2 = getComputedStyle($("#vt-reason")).visibility === "hidden" && $("#vt-reason").textContent === "";
			probes.push({ id: id === pdf ? "pdf" : "image", tool, width, below, hvd: hv, fvd: fv, hover: h, focus: f, hoverInView: hv.ok, focusInView: fv.ok, gone1, gone2 });
		}
	}
	const bad = (k) => probes.filter((p) => !p[k]);
	const okRules = (p) => p.hover.ok && p.focus.ok;
	check("reason: on hover and on focus it shows the sentence, at most half the row, whole (wrapped, not cut), inside the row, clear of the list, at 1100 and 1000 px (the least the app allows)", probes.every(okRules), JSON.stringify(probes.filter((p) => !okRules(p)).map((p) => ({ ...p.hover, tool: p.tool, width: p.width, kind: p.id }))).slice(0, 600));
	check("reason: it never pushes the active tab out of view (hover and focus, two widths)", probes.every((p) => p.hoverInView && p.focusInView), JSON.stringify(probes.filter((p) => !p.hoverInView || !p.focusInView).map((p) => [p.id, p.tool, p.width, p.hoverInView ? p.fvd : p.hvd, p.hover.w])));
	check("reason: the page view always starts below the row (the row grows with a long reason, the view follows)", probes.every((p) => p.below), JSON.stringify(probes.filter((p) => !p.below).map((p) => [p.id, p.tool, p.width])));
	check("reason: it disappears when the pointer leaves and when focus leaves", probes.every((p) => p.gone1 && p.gone2), JSON.stringify(bad("gone1").concat(bad("gone2")).map((p) => [p.id, p.tool, p.width])));
	const pdfAnnotate = probes.find((p) => p.id === "pdf" && p.tool === "annotate" && p.width === 1100);
	check("pdf reason (Annotate): reads \"Needs a web page or an image. This tab shows a PDF.\"", !!pdfAnnotate && pdfAnnotate.hover.text === PDF_REASON && pdfAnnotate.focus.text === PDF_REASON, JSON.stringify(pdfAnnotate && pdfAnnotate.hover.text));
	// The sentence is long: in a narrow row it wraps to several lines instead of being cut (the row grows, the page view follows).
	const wrapped = probes.find((p) => p.id === "pdf" && p.tool === "annotate" && p.width === 1000);
	check("reason: in a narrow row it wraps to several lines instead of being cut", !!wrapped && wrapped.focus.h > 14 && wrapped.focus.ok, JSON.stringify(wrapped && wrapped.focus));
	// The + reason follows the same rule.
	await crust.selftest.resize(1000, sz[1]);
	await sleep(500);
	while ((await list()).tabs.length < 8) await mk(web);
	await until(() => R.state().tabs.length === 8);
	$("#vt-add").focus();
	await sleep(250);
	const lim = reasonRules($("#vt-limit"), R.LIMIT_REASON);
	check("reason of +: at 8 tabs on focus, at most half the row, whole, inside the row (1000 px)", lim.ok, JSON.stringify(lim));
	check("reason of +: the active tab stays in view while it shows", (await visibleTab(R.state().activeId)).ok, JSON.stringify(inView(R.state().activeId)));
	$("#vt-add").blur();

	// --- 4. a scrolling list fades on the cut-off side ----------------------------------------------------------------------------------
	const L = LIST();
	const maskOf = () => getComputedStyle(L).maskImage || getComputedStyle(L).webkitMaskImage || "none";
	await crust.selftest.resize(1000, sz[1]);
	await sleep(500);
	check("fade: more tabs than room (the list scrolls)", L.scrollWidth > L.clientWidth + 1, JSON.stringify([L.scrollWidth, L.clientWidth]));
	const max = L.scrollWidth - L.clientWidth;
	const fadeAt = async (x) => {
		L.scrollLeft = x;
		await sleep(150);
		return { fade: L.dataset.fade || "", mask: maskOf(), at: Math.round(L.scrollLeft) };
	};
	const f0 = await fadeAt(0);
	check("fade: scrolled to the start, the right side fades and the left does not", f0.fade === "right" && f0.mask !== "none", JSON.stringify(f0));
	const fm = await fadeAt(Math.round(max / 2));
	check("fade: scrolled to the middle, both sides fade", fm.fade === "both" && fm.mask !== "none", JSON.stringify(fm));
	const fe = await fadeAt(max);
	check("fade: scrolled to the end, the left side fades and the right does not", fe.fade === "left" && fe.mask !== "none", JSON.stringify(fe));
	while (R.state().tabs.length > 2) await B.closeTab(R.state().tabs[R.state().tabs.length - 1].id);
	await until(() => R.state().tabs.length === 2);
	await crust.selftest.resize(sz[0], sz[1]);
	await sleep(700);
	check("fade: a row that fits has no fade", !L.dataset.fade && maskOf() === "none", JSON.stringify([L.dataset.fade, maskOf()]));
};
