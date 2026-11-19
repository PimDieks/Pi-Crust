// Self-test, the row of page tabs (src/viewer-tab-row.js). Called by the `viewer-tabs` step (viewer-tabs-selftest.js) after the model checks, with
// the step's helpers. Drives the real DOM of the row (clicks, keys) and the real views through the IPC; screenshots go to out/ (vt-*.png).
"use strict";

window.viewerTabsRowChecks = async function viewerTabsRowChecks({ S, check, snap, sleep, list, byId, ids }) {
	const B = crust.browser;
	const R = window.crustViewerRow;
	const web = `http://127.0.0.1:${S.port}/`;
	const ROW = () => $("#viewer-tabs");
	const rowItems = () => [...$("#vt-list").children];
	const rowTabs = () => [...$("#vt-list").querySelectorAll('[role="tab"]')];
	const rect = (n) => n.getBoundingClientRect();
	const sel = (n) => n.getAttribute("aria-selected") === "true";
	const until = async (fn, ms = 4000) => {
		for (let t = 0; t < ms; t += 50) {
			if (fn()) return true;
			await sleep(50);
		}
		return !!fn();
	};
	const modKeys = isMac ? { metaKey: true } : { ctrlKey: true };
	const press = (key, extra = {}, target = document.body) => target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...extra }));
	const devPrefix = S.devUrl.replace(/\/$/, "");

	await crust.selftest.focusEmulation(true); // the offscreen window has no focus: let the page match :focus anyway
	switchTab("browser");
	await sleep(500);
	// One tab on the loopback page to start from.
	while ((await list()).tabs.length > 1) await B.closeTab((await list()).tabs[0].id);
	await B.navigate(web);
	await until(() => rowTabs().length === 1 && /web page/.test(rowTabs()[0].textContent));

	// --- one tab: structure, names, the view sits below the row ------------------------------------------------------------------
	check("row: shown in the Viewer tab, a tab list named Pages with one tab", !ROW().hidden && ROW().getClientRects().length > 0 && $("#vt-list").getAttribute("role") === "tablist" && $("#vt-list").getAttribute("aria-label") === "Pages" && rowTabs().length === 1, rowTabs().length);
	check("row: it sits under the address bar and above the page", rect($(".browser-bar")).bottom <= rect(ROW()).top + 0.5 && rect(ROW()).bottom <= rect($("#browser-slot")).top + 0.5);
	const unnamed = [...ROW().querySelectorAll("button, [role=tab]")].filter((n) => !(n.getAttribute("aria-label") || n.textContent || "").trim());
	check("row: every control has an accessible name", unnamed.length === 0, unnamed.map((n) => n.className));
	const b0 = await crust.selftest.bounds();
	check("row: the page view starts exactly at the slot, below the row", Math.abs(b0.view.y - rect($("#browser-slot")).top * b0.z) <= 1.5 && b0.view.y >= rect(ROW()).bottom * b0.z - 1, JSON.stringify({ viewY: b0.view.y, rowBottom: rect(ROW()).bottom, slotTop: rect($("#browser-slot")).top, z: b0.z, hidden: b0.hidden }));
	const rowH = rect(ROW()).height;

	// --- titles, kind marks, shortening --------------------------------------------------------------------------------------------
	check("title: the page title of a web page", rowTabs()[0].textContent.trim().startsWith("web page"), rowTabs()[0].textContent);
	check("title: no kind mark on a web page", !ROW().querySelector(".vt-item .vt-mark:not([hidden]) svg"));
	check("title: file name when there is no page title (pure)", R.titleOf({ title: "", address: "pi-project://p-abc/docs/pricing.html", session: "project:p-abc" }) === "pricing.html");
	check("title: host when there is neither (pure)", R.titleOf({ title: "", address: "http://localhost:5173/", session: "web" }) === "localhost:5173");
	const long30 = "abcdefghijklmnopqrstuvwxyz0123";
	check("title: more than 24 characters is cut to 24 with an ellipsis; 24 stays whole (pure)", [...R.shorten(long30)].length === 24 && R.shorten(long30).endsWith("…") && R.shorten(long30.slice(0, 24)) === long30.slice(0, 24));
	let r = await B.createTab(S.long);
	const longId = r.tabId;
	await until(() => (R.state().tabs.find((t) => t.id === longId) || { title: "" }).title.startsWith("A very long"));
	const fullLong = "A very long page title that goes past twenty-four characters";
	let it = R.items().get(longId);
	check("title: a long page title shows 24 characters, the tooltip has the whole title", it && [...it.label.textContent].length === 24 && it.item.title.split("\n")[0] === fullLong, it && it.label.textContent + " | " + it.item.title);
	check("kind mark: a project page has the page mark", it && it.mark.dataset.kind === "page" && !!it.mark.querySelector("svg"), it && it.mark.dataset.kind);
	r = await B.createTab(S.image);
	const imgId = r.tabId;
	await until(() => R.items().get(imgId) && R.items().get(imgId).mark.dataset.kind === "image");
	check("kind mark: an image", R.items().get(imgId).mark.dataset.kind === "image", R.items().get(imgId).mark.dataset.kind);
	r = await B.createTab(S.pdf);
	const pdfId = r.tabId;
	await until(() => R.items().get(pdfId) && R.items().get(pdfId).mark.dataset.kind === "pdf");
	check("kind mark: a PDF", R.items().get(pdfId).mark.dataset.kind === "pdf", R.items().get(pdfId).mark.dataset.kind);
	await B.closeTab(pdfId);
	await B.closeTab(imgId);
	await B.closeTab(longId);
	await until(() => rowTabs().length === 1);

	// --- + : a new tab on the dev address, cursor in the address bar -----------------------------------------------------------
	$("#vt-add").click();
	await until(() => rowTabs().length === 2 && document.activeElement === $("#url"));
	check("+: a second tab, active, the dev address in the bar, the cursor in the address bar", rowTabs().length === 2 && sel(rowTabs()[1]) && document.activeElement === $("#url") && $("#url").value.startsWith(devPrefix) && $("#url").selectionStart === 0 && $("#url").selectionEnd === $("#url").value.length, `${rowTabs().length} ${document.activeElement && document.activeElement.id} ${$("#url").value}`);
	check("+: the order of the row is the order of the list", JSON.stringify(rowItems().map((n) => n.dataset.id)) === JSON.stringify(ids(await list())));
	check("+: the view is still below the row (the row did not move)", Math.abs(rect(ROW()).height - rowH) < 0.5 && (await crust.selftest.bounds()).view.y >= rect(ROW()).bottom * b0.z - 1);
	// The new tab is on the dev address with nothing listening: the error box shows; switching to the page tab hides it.
	await until(() => !$("#browser-error").hidden);
	check("state: the error box shows the active tab's error", !$("#browser-error").hidden && /Can't load/.test($("#browser-error").textContent), $("#browser-error").textContent);
	check("state: the failed tab's view is hidden so the box shows (not covered)", (await crust.selftest.bounds()).hidden.includes("error"));

	// --- activate: click ---------------------------------------------------------------------------------------------------------
	rowTabs()[0].click();
	await until(() => sel(rowTabs()[0]) && $("#browser-error").hidden);
	const l2 = await list();
	check("click: a tab becomes the active one; the address bar and the error box switch with it", l2.activeId === rowItems()[0].dataset.id && sel(rowTabs()[0]) && !sel(rowTabs()[1]) && $("#url").value === byId(l2, l2.activeId).address && $("#browser-error").hidden, `${$("#url").value} err hidden=${$("#browser-error").hidden}`);
	check("click: back and forward follow the active tab", $('[data-action="back"]').disabled === !byId(l2, l2.activeId).canGoBack && $('[data-action="forward"]').disabled === !byId(l2, l2.activeId).canGoForward);

	// --- activate: keys -----------------------------------------------------------------------------------------------------------
	press("ArrowRight", { ...modKeys, altKey: true });
	await until(() => sel(rowTabs()[1]));
	check("keys: Alt+Ctrl(Cmd)+Right goes to the next page", sel(rowTabs()[1]));
	press("ArrowRight", { ...modKeys, altKey: true });
	await until(() => sel(rowTabs()[0]));
	check("keys: and wraps round to the first", sel(rowTabs()[0]));
	press("ArrowLeft", { ...modKeys, altKey: true });
	await until(() => sel(rowTabs()[1]));
	check("keys: Alt+Ctrl(Cmd)+Left goes to the previous page (wraps)", sel(rowTabs()[1]));
	$("#url").focus();
	$("#url").value = "typed but not sent";
	press("ArrowLeft", { ...modKeys, altKey: true });
	await until(() => sel(rowTabs()[0]));
	const l3 = await list();
	check("keys: a switch replaces unsent text in the address bar", $("#url").value === byId(l3, l3.activeId).address, $("#url").value);
	check("focus: one tab stop in the list (the active tab); the close buttons are not stops", rowTabs().filter((n) => n.tabIndex === 0).length === 1 && rowTabs()[0].tabIndex === 0 && [...ROW().querySelectorAll(".vt-close")].every((n) => n.tabIndex === -1));
	rowTabs()[0].focus();
	press("ArrowRight", {}, rowTabs()[0]);
	await until(() => sel(rowTabs()[1]));
	check("arrows: ArrowRight in the list moves focus and shows that page", document.activeElement === rowTabs()[1] && sel(rowTabs()[1]) && rowTabs()[1].tabIndex === 0 && rowTabs()[0].tabIndex === -1);
	press("Home", {}, rowTabs()[1]);
	await until(() => sel(rowTabs()[0]));
	check("arrows: Home goes to the first tab", document.activeElement === rowTabs()[0] && sel(rowTabs()[0]));
	press("End", {}, rowTabs()[0]);
	await until(() => sel(rowTabs()[1]));
	check("arrows: End goes to the last tab", document.activeElement === rowTabs()[1] && sel(rowTabs()[1]));
	const stops = [...document.querySelectorAll('.tab-panel[data-panel="browser"] button, .tab-panel[data-panel="browser"] input, .tab-panel[data-panel="browser"] [tabindex]')].filter((n) => !n.disabled && n.tabIndex >= 0 && n.getClientRects().length);
	const iUrl = stops.indexOf($("#url"));
	const iTab = stops.indexOf(rowTabs()[1]);
	const iAdd = stops.indexOf($("#vt-add"));
	check("focus order: address bar, then the active tab, then +", iUrl >= 0 && iTab > iUrl && iAdd === iTab + 1, JSON.stringify([iUrl, iTab, iAdd]));

	// --- close: x, middle button, Delete, Ctrl/Cmd+W ------------------------------------------------------------------------------
	await B.createTab(web);
	await B.createTab(web);
	await until(() => rowTabs().length === 4);
	const before4 = rowItems().map((n) => n.dataset.id);
	rowItems()[0].querySelector(".vt-close").click();
	await until(() => rowTabs().length === 3);
	check("close: x closes that tab", rowTabs().length === 3 && !rowItems().some((n) => n.dataset.id === before4[0]), JSON.stringify(rowItems().map((n) => n.dataset.id)));
	const activeBefore = (await list()).activeId;
	const midId = rowItems().find((n) => n.dataset.id !== activeBefore).dataset.id;
	rowItems().find((n) => n.dataset.id === midId).dispatchEvent(new MouseEvent("auxclick", { button: 1, bubbles: true, cancelable: true }));
	await until(() => rowTabs().length === 2);
	check("close: the middle mouse button closes a tab", rowTabs().length === 2 && !rowItems().some((n) => n.dataset.id === midId));
	await B.createTab(web);
	await until(() => rowTabs().length === 3);
	rowTabs().find((n) => !sel(n)).focus();
	const delId = document.activeElement.closest(".vt-item").dataset.id;
	press("Delete", {}, document.activeElement);
	await until(() => rowTabs().length === 2);
	check("close: Delete on a focused tab closes it; focus stays in the row, on the active tab", rowTabs().length === 2 && !rowItems().some((n) => n.dataset.id === delId) && ROW().contains(document.activeElement) && sel(document.activeElement), document.activeElement && document.activeElement.className);
	const nb = rowTabs().length;
	const actNow = (await list()).activeId;
	press("w", modKeys);
	await until(() => rowTabs().length === nb - 1);
	check("close: Ctrl/Cmd+W closes the active tab", rowTabs().length === nb - 1 && !rowItems().some((n) => n.dataset.id === actNow));
	press("t", modKeys);
	await until(() => rowTabs().length === nb && document.activeElement === $("#url"));
	check("keys: Ctrl/Cmd+T opens a page and puts the cursor in the address bar", rowTabs().length === nb && document.activeElement === $("#url"));
	switchTab("terminal");
	await sleep(300);
	const nHidden = rowTabs().length;
	press("t", modKeys);
	press("w", modKeys);
	press("ArrowLeft", { ...modKeys, altKey: true });
	await sleep(500);
	check("keys: nothing happens when the Viewer tab is not shown", rowTabs().length === nHidden && (await list()).tabs.length === nHidden);
	switchTab("browser");
	await sleep(400);
	while ((await list()).tabs.length > 1) await B.closeTab((await list()).tabs[0].id);
	await until(() => rowTabs().length === 1);
	const lastId2 = rowItems()[0].dataset.id;
	rowItems()[0].querySelector(".vt-close").click();
	await until(() => rowTabs().length === 1 && rowItems()[0].dataset.id !== lastId2);
	const l4 = await list();
	check("close: the last tab is replaced by a fresh one on the dev address", rowTabs().length === 1 && rowItems()[0].dataset.id !== lastId2 && byId(l4, l4.activeId).address.startsWith(devPrefix));
	await B.navigate(web);
	await until(() => /web page/.test(rowTabs()[0].textContent));

	// --- screenshots: one tab (row shown, and with the row hidden for the comparison), three tabs, a 2x crop of the row -------------
	const shots = [];
	const themed = async (name, crop) => {
		for (const th of ["light", "dark"]) {
			setTheme(th);
			await sleep(700);
			shots.push(await crust.selftest.capture(`vt-${name}-${th}`, crop));
		}
	};
	await themed("one");
	const hideStyle = document.createElement("style");
	hideStyle.textContent = "#viewer-tabs { display: none; }";
	document.head.append(hideStyle);
	await sleep(300);
	await themed("one-row-hidden");
	hideStyle.remove();
	await B.createTab(S.page);
	await B.createTab(S.image);
	await until(() => rowTabs().length === 3 && R.items().get(rowItems()[2].dataset.id).mark.dataset.kind === "image" && !R.state().tabs.some((t) => t.loading));
	check("three tabs: a web page, a project page, an image", rowTabs().length === 3 && R.items().get(rowItems()[1].dataset.id).mark.dataset.kind === "page" && R.items().get(rowItems()[2].dataset.id).mark.dataset.kind === "image");
	await themed("three");
	{
		const rr = rect(ROW());
		const top = rect($(".browser-bar")).top;
		await themed("three-row-2x", { x: rr.left, y: top, width: rr.width, height: rr.bottom - top, scale: 2 });
	}

	// --- eight tabs, the limit and its reason -------------------------------------------------------------------------------------
	while ((await list()).tabs.length < 8) await B.createTab(web);
	await until(() => rowTabs().length === 8);
	check("limit: at 8 tabs + is disabled (aria-disabled), the reason is its tooltip and its description", $("#vt-add").getAttribute("aria-disabled") === "true" && $("#vt-add").title === R.LIMIT_REASON && $("#vt-add").getAttribute("aria-describedby") === "vt-limit" && $("#vt-limit").textContent === "8 pages is the most. Close one first.", $("#vt-add").title);
	$("#vt-add").click();
	await sleep(500);
	check("limit: clicking + at 8 opens nothing", (await list()).tabs.length === 8 && rowTabs().length === 8);
	$("#vt-add").focus();
	check("limit: + can still be focused (the reason is reachable by keyboard)", document.activeElement === $("#vt-add"));
	await until(() => getComputedStyle($("#vt-limit")).opacity === "1" && rect($("#vt-limit")).width > 100);
	const lim = rect($("#vt-limit"));
	check("limit: the reason shows inside the row on focus, not covered, not below the row", getComputedStyle($("#vt-limit")).opacity === "1" && lim.width > 100 && lim.top >= rect(ROW()).top - 0.5 && lim.bottom <= rect(ROW()).bottom + 0.5 && document.elementFromPoint(lim.left + lim.width / 2, lim.top + lim.height / 2) === $("#vt-limit"), JSON.stringify(lim));
	await themed("eight-limit");
	$("#url").focus();
	press("t", modKeys);
	await sleep(400);
	check("limit: Ctrl/Cmd+T at 8 opens nothing and puts focus on +", (await list()).tabs.length === 8 && document.activeElement === $("#vt-add"));
	const geometry = async (what) => {
		const rr = rect(ROW());
		const its = rowItems().map(rect);
		const add = rect($("#vt-add"));
		const lr = rect($("#vt-list"));
		const oneLine = its.every((x) => Math.abs(x.top - its[0].top) < 1 && x.bottom <= rr.bottom + 0.5 && x.top >= rr.top - 0.5);
		const addIn = add.left >= rr.left && add.right <= rr.right + 0.5 && add.bottom <= rr.bottom + 0.5 && add.left >= lr.right - 0.5;
		const noOverlap = its.every((x, i) => i === 0 || x.left >= its[i - 1].right - 0.5);
		const fitsOrScrolls = $("#vt-list").scrollWidth <= $("#vt-list").clientWidth + 1 || getComputedStyle($("#vt-list")).overflowX !== "visible";
		const bb = await crust.selftest.bounds();
		const below = bb.view.y >= rr.bottom * bb.z - 1 && Math.abs(rr.height - rowH) < 0.5 && ROW().scrollWidth <= ROW().clientWidth + 1;
		const covered = rowTabs().filter((n) => {
			const q = rect(n);
			if (q.right > lr.right || q.left < lr.left) return false; // scrolled out of the list's view, not covered
			const mid = document.elementFromPoint(q.left + q.width / 2, q.top + q.height / 2);
			return !(mid === n || n.contains(mid));
		}).length;
		check(`geometry (${what}): one line, no overlap, + visible beside the list, the list scrolls or fits, the view below the row, nothing on top of a tab`, oneLine && addIn && noOverlap && fitsOrScrolls && below && covered === 0, JSON.stringify({ oneLine, addIn, noOverlap, fitsOrScrolls, below, covered, list: [$("#vt-list").scrollWidth, $("#vt-list").clientWidth] }));
	};
	await geometry("wide");
	const sz = [innerWidth, innerHeight];
	await crust.selftest.resize(1100, sz[1]);
	await sleep(700);
	await geometry("narrow 1100px");
	check("geometry: in a narrow window the list scrolls (more tabs than room)", $("#vt-list").scrollWidth > $("#vt-list").clientWidth, JSON.stringify([$("#vt-list").scrollWidth, $("#vt-list").clientWidth]));
	await crust.selftest.resize(sz[0], sz[1]);
	await sleep(700);
	await B.closeTab(rowItems()[7].dataset.id);
	await until(() => rowTabs().length === 7);
	check("limit: below 8 + is enabled again with its normal tooltip", $("#vt-add").getAttribute("aria-disabled") === "false" && !$("#vt-add").hasAttribute("aria-describedby") && /New page/.test($("#vt-add").title) && $("#vt-limit").hidden);
	console.error(`SELFTEST viewer-tabs screenshots: ${shots.map((s) => String(s).replace(/^.*[\\/]/, "")).join(", ")}`);
	while ((await list()).tabs.length > 1) await B.closeTab((await list()).tabs[0].id);
};
