// Self-test step `viewer-open`: the three ways to open a project file in the Viewer (src/viewer-open.js, viewer-open-main.js): the address bar
// (the plain project path, suggestions, refusals), the tree's menu and the Editor's button, and a drop. Everything is driven through the real UI
// (the form, the keys, the menu, the drag and drop events) and the real IPC; the main side (viewer-open-selftest-main.js) builds a throwaway
// project, a folder outside it, a link that points outside it and a loopback web page. Run: npm run selftest -- viewer-open
// Screenshots (light and dark): set PI_CRUST_VO_SHOTDIR to a folder; they are named vo-<what>-<theme>.png.
// Deliberate breaks, each of which must make the step report MISMATCH (PI_CRUST_SELFTEST_VIEWER_BREAK=<name>):
//   open-bar   a typed path with a dot segment is not refused        open-tree  the tree menu offers the item for every file
//   open-drop  a dropped path is judged by its name, not by where it really leads
// Not covered here: a real drop from Explorer or Finder (a script cannot make the OS give a File a real path); the step passes the path on the
// File (`testPath`, honoured only in a selftest) and checks everything after it. webUtils.getPathForFile itself is Electron's.
"use strict";

selftestSteps.push(async () => {
	const checks = [];
	const check = (name, ok, detail) => {
		checks.push({ name, ok: !!ok });
		console.error(`SELFTEST viewer-open ${name}: ${ok ? "OK" : "MISMATCH" + (detail === undefined ? "" : " (" + String(detail).slice(0, 400) + ")")}`);
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
	const T = (op, extra = {}) => crust.selftest.viewerOpen({ op, ...extra });
	const R = {
		outside: "Only files inside this project can be shown here.",
		folder: "Folders can't be shown here. Choose a file.",
		dot: "Files and folders that start with a dot are never shown here.",
		kind: "Only web pages (HTML), images and PDFs can be shown here.",
		missing: "No such file in this project.",
		scheme: "Only web addresses (http, https) and files in this project can be shown here.",
		unknown: "That is not a web address or a file in this project.",
		invalid: "That path can't be shown here.",
		limit: "8 pages is the most. Close one first.",
	};
	const list = () => B.tabs();
	const activeTab_ = async () => {
		const l = await list();
		return l.tabs.find((t) => t.id === l.activeId);
	};
	const where = (a) => (a || "").replace(/^pi-project:\/\/[^/]+\//, "").replace(/%20/g, " ");
	const reset = async () => {
		for (const k of ["address-suggest", "tree-menu", "drop"]) await B.hide(false, k);
		window.viewerOpen.closeSuggestions();
		window.viewerOpen.closeMenu();
		window.viewerOpen.hideHint();
		window.viewerOpen.clearRefusal();
		while ((await list()).tabs.length > 1) await B.closeTab((await list()).tabs[0].id);
		$("#toasts").replaceChildren();
	};
	const bar = () => $("#url");
	const reasonEl = () => $("#vt-reason");
	const hiddenNow = async () => (await crust.selftest.bounds()).hidden;
	const press = (key, extra = {}) => bar().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...extra }));
	// Type into the bar the way a person does (value and an input event), or press Enter in it (the real form submit).
	const typeText = (text) => {
		bar().focus();
		bar().value = text;
		bar().dispatchEvent(new Event("input", { bubbles: true }));
	};
	const submit = async (text) => {
		bar().focus();
		bar().value = text;
		$("#url-form").requestSubmit();
		await sleep(350);
	};
	const toastText = () => $("#toasts").textContent;
	const TREE = () => window.viewerOpen.TREE_TYPE;
	const dt = ({ files = [], tree = "", text = "" } = {}) => {
		const d = new DataTransfer();
		for (const f of files) d.items.add(f);
		if (tree) d.setData(TREE(), tree);
		if (text) d.setData("text/plain", text);
		return d;
	};
	const drag = (type, target, d) => target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: d }));
	const fileWith = (name, testPath) => {
		const f = new File(["x"], name);
		if (testPath !== undefined) f.testPath = testPath;
		return f;
	};
	let S;
	try {
		S = await T("start");
		const root = S.root;
		const abs = (...p) => [root, ...p].join(S.sep);
		const addr = async (rel) => (await T("address", { root, rel })).address;
		await crust.selftest.focusEmulation(true);
		switchTab("browser");
		await sleep(500);
		await reset();
		const vo = window.viewerOpen;

		// =============================================================================================================================
		// Task 9: the address bar
		// =============================================================================================================================
		// --- the bar shows the plain project path, never the internal address -------------------------------------------------------
		for (const [rel, kind] of [["docs/pricing.html", "page"], ["docs/My Page.html", "page"], ["img/logo.svg", "image"], ["img/photo.png", "image"], ["brochure.pdf", "pdf"]]) {
			bar().blur();
			const r = await B.createTab(await addr(rel));
			await until(async () => (await activeTab_()).kind === kind && bar().value === rel);
			const t = await activeTab_();
			check(`bar: ${rel} shows as its project path, forward slashes, no internal address (${kind} tab)`, r.ok && bar().value === rel && !/pi-project|p-[0-9a-f]{8}/.test(bar().value) && t.kind === kind && t.session.startsWith("project:"), `${r.ok} "${bar().value}" ${t && t.kind}`);
		}
		// --- Enter on the shown text round-trips: same file, same tab, same text -----------------------------------------------------
		await reset();
		await B.activateTab((await list()).tabs[0].id);
		await B.createTab(await addr("docs/pricing.html"));
		await until(async () => bar().value === "docs/pricing.html");
		let l = await list();
		const nBefore = l.tabs.length;
		const idBefore = l.activeId;
		const addrBefore = (await activeTab_()).address;
		bar().blur();
		await submit(bar().value);
		bar().blur();
		l = await list();
		check("bar: Enter on the shown path round-trips (same tab, same address, same text)", l.tabs.length === nBefore && l.activeId === idBefore && (await activeTab_()).address === addrBefore && bar().value === "docs/pricing.html", `${l.tabs.length}/${nBefore} ${bar().value}`);
		await submit("docs\\pricing.html"); // a back slash is the same file
		bar().blur();
		check("bar: a back slash path is the same file", (await list()).tabs.length === nBefore && (await activeTab_()).address === addrBefore);
		// --- a typed path loads in place (project tab), reuses the tab that already shows the file, opens a tab from a web page --------
		await submit("docs/guide/start.html");
		await until(async () => where((await activeTab_()).address) === "docs/guide/start.html");
		bar().blur();
		check("bar: a project path typed in a project tab loads there (no new tab)", (await list()).tabs.length === nBefore && (await activeTab_()).id === idBefore && where((await activeTab_()).address) === "docs/guide/start.html");
		await B.createTab(await addr("docs/about-us.html"));
		await until(async () => bar().value === "docs/about-us.html");
		const aboutId = (await list()).activeId;
		await submit("docs/guide/start.html"); // another tab already shows it
		bar().blur();
		l = await list();
		check("bar: a file another tab already shows is switched to, not opened twice", l.activeId === idBefore && l.tabs.length === nBefore + 1, JSON.stringify({ active: l.activeId, want: idBefore, n: l.tabs.length }));
		await B.createTab(`http://127.0.0.1:${S.port}/`);
		await until(async () => /^http:/.test((await activeTab_()).address) && (await activeTab_()).title === "Web page");
		const webId = (await list()).activeId;
		const nWeb = (await list()).tabs.length;
		await submit("img/logo.svg"); // from a web tab: a project file needs the other session, so a new tab
		await until(async () => (await activeTab_()).kind === "image");
		bar().blur();
		l = await list();
		let t = await activeTab_();
		check("bar: a project path typed in a web tab opens a new project tab (image), the web tab stays", l.tabs.length === nWeb + 1 && t.id !== webId && t.session.startsWith("project:") && l.tabs.find((x) => x.id === webId).session === "web", JSON.stringify(t));
		await B.activateTab(webId);
		await submit("docs/about-us.html");
		bar().blur();
		check("bar: from a web tab, a file already open elsewhere is switched to", (await list()).activeId === aboutId && (await list()).tabs.length === nWeb + 1);
		// --- web addresses behave as before -------------------------------------------------------------------------------------------
		await B.activateTab(webId);
		const rw = await B.navigate(`http://127.0.0.1:${S.port}/x`);
		check("web: an http address still loads in the web tab", rw.ok === true && rw.tabId === webId, JSON.stringify(rw));
		const rh = await B.navigate(`127.0.0.1:${S.port}/x`);
		await sleep(300);
		check("web: host-like text still gets https:// (as before)", rh.ok === true && /^https:\/\/127\.0\.0\.1:/.test((await list()).tabs.find((x) => x.id === webId).address), JSON.stringify(rh) + " " + (await list()).tabs.find((x) => x.id === webId).address);
		await B.navigate(`http://127.0.0.1:${S.port}/`);

		// --- every refusal, with its reason, in the bar's reason line; nothing opens ---------------------------------------------------
		await reset();
		await B.createTab(await addr("docs/pricing.html"));
		await until(async () => bar().value === "docs/pricing.html");
		const here = await list();
		const refusals = [
			["file:///C:/Users/alex/secret.html", R.scheme],
			["javascript:alert(1)", R.scheme],
			["data:text/html,hi", R.scheme],
			["../outside/secret.html", R.outside],
			[S.outsideFile, R.outside],
			[".hidden/secret.html", R.dot],
			[".env", R.dot],
			["notes.txt", R.kind],
			["src/app.js", R.kind],
			["docs", R.folder],
			["docs/nothing.html", R.missing],
			["hello world", R.unknown],
			["pi-project://p-0000000000000000/index.html", R.outside],
		];
		if (S.link) refusals.push(["linkdir/secret.html", R.outside]);
		for (const [text, why] of refusals) {
			vo.clearRefusal();
			await submit(text);
			const ok = reasonEl().textContent === why && reasonEl().classList.contains("show") && bar().getAttribute("aria-invalid") === "true" && bar().getAttribute("aria-describedby") === "vt-reason";
			const now = await list();
			const same = now.tabs.length === here.tabs.length && now.activeId === here.activeId && (await activeTab_()).address === (here.tabs.find((x) => x.id === here.activeId) || {}).address;
			check(`refusal: "${text.length > 40 ? text.slice(0, 40) + "..." : text}" is refused (${why.slice(0, 34)}...) and nothing opens`, ok && same, `reason="${reasonEl().textContent}" invalid=${bar().getAttribute("aria-invalid")} same=${same}`);
		}
		vo.clearRefusal();
		await submit("../outside/secret.html");
		bar().value += "x";
		bar().dispatchEvent(new Event("input", { bubbles: true }));
		check("refusal: the next keystroke clears the reason and the outline", bar().getAttribute("aria-invalid") !== "true" && !reasonEl().classList.contains("show") && reasonEl().textContent === "");
		await submit("../outside/secret.html");
		press("Escape");
		check("refusal: Escape clears it", bar().getAttribute("aria-invalid") !== "true" && !reasonEl().classList.contains("show"));
		await submit("../outside/secret.html");
		await B.createTab(await addr("index.html"));
		await sleep(300);
		check("refusal: a switch of tab clears it", bar().getAttribute("aria-invalid") !== "true" && !reasonEl().classList.contains("show"));
		bar().blur();

		// --- suggestions ---------------------------------------------------------------------------------------------------------------
		await reset();
		await B.createTab(await addr("index.html"));
		await sleep(300);
		const sug = () => vo.items().map((i) => i.path);
		const shown = () => !!vo.list() && !vo.list().hidden && vo.list().getClientRects().length > 0;
		typeText("pric");
		await until(() => vo.isOpen());
		check("suggest: typing opens a list with the matching project file", shown() && JSON.stringify(sug()) === JSON.stringify(["docs/pricing.html"]), JSON.stringify(sug()));
		const lz = getComputedStyle(vo.list()).zIndex;
		check("suggest: the list is on the popover layer and is a labelled listbox with options", lz === getComputedStyle(document.documentElement).getPropertyValue("--layer-popover").trim() && vo.list().getAttribute("role") === "listbox" && vo.list().querySelectorAll('[role="option"]').length === 1 && bar().getAttribute("aria-expanded") === "true", lz);
		let hid = await hiddenNow();
		check("suggest: the page view is hidden while the list is open", hid.includes("address-suggest") && !(await crust.selftest.bounds()).visible, JSON.stringify(hid));
		const rect = vo.list().getBoundingClientRect();
		const br = bar().getBoundingClientRect();
		check("suggest: the list sits right under the bar", Math.abs(rect.left - br.left) < 8 && rect.top >= br.bottom && rect.top - br.bottom < 16, JSON.stringify([rect.left, rect.top, br.left, br.bottom]));
		press("Escape");
		await sleep(150);
		hid = await hiddenNow();
		check("suggest: Escape closes it and gives the page view back", !shown() && !vo.isOpen() && !hid.includes("address-suggest") && bar().getAttribute("aria-expanded") === "false", JSON.stringify(hid));

		typeText("doc");
		await until(() => vo.isOpen());
		const docs = sug();
		check("suggest: only project files of the shown kinds that match, by path", docs.length >= 4 && docs.every((p) => /\.(html|svg|png|pdf)$/.test(p) && /doc/i.test(p)) && docs.includes("docs/pricing.html") && docs.includes("docs/guide/start.html"), JSON.stringify(docs));
		press("ArrowDown");
		check("suggest: ArrowDown highlights the first item (aria-activedescendant)", vo.highlighted() === 0 && bar().getAttribute("aria-activedescendant") === "url-suggest-0" && vo.list().children[0].getAttribute("aria-selected") === "true");
		press("ArrowDown");
		press("ArrowUp");
		press("ArrowUp");
		check("suggest: ArrowUp from the first wraps to the last", vo.highlighted() === vo.items().length - 1, vo.highlighted());
		press("ArrowDown"); // back to the first
		const first = vo.items()[0];
		const nTabs = (await list()).tabs.length;
		press("Enter");
		await until(async () => where((await activeTab_()).address) === first.path);
		bar().blur();
		check("suggest: Enter on the highlighted item opens that file and closes the list", where((await activeTab_()).address) === first.path && !vo.isOpen() && !(await hiddenNow()).includes("address-suggest") && (await list()).tabs.length === nTabs, `${where((await activeTab_()).address)} want ${first.path}`);

		typeText("page");
		await until(() => vo.isOpen());
		check("suggest: at most 8 items (12 files match)", vo.items().length === 8 && vo.list().querySelectorAll(".pal-item").length === 8, vo.items().length);
		for (const [q, why] of [["secret", "a dot folder and a link"], [".hidden", "a dot folder"], ["node_modules", "node_modules"], ["readme", "node_modules"], ["notes", "a kind the Viewer does not show"], ["app.js", "a kind the Viewer does not show"], ["env", "a dot file"], ...(S.gitOk ? [["skip", "something git ignores"]] : [])]) {
			vo.closeSuggestions();
			typeText(q);
			await sleep(350);
			check(`suggest: "${q}" offers nothing (${why})`, !vo.isOpen() && vo.items().length === 0, JSON.stringify(sug()));
		}
		// Mouse: press and click an item; the bar does not lose focus on the press.
		vo.closeSuggestions();
		typeText("logo");
		await until(() => vo.isOpen());
		const item = vo.list().querySelector(".pal-item");
		const md = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
		item.dispatchEvent(md);
		check("suggest: a mouse press on an item does not take focus from the bar", md.defaultPrevented);
		item.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		await until(async () => (await activeTab_()).kind === "image");
		check("suggest: a click on an item opens the file and closes the list", where((await activeTab_()).address) === "img/logo.svg" && !vo.isOpen() && !(await hiddenNow()).includes("address-suggest"));
		bar().blur();
		typeText("pri");
		await until(() => vo.isOpen());
		bar().blur();
		await sleep(150);
		check("suggest: blur closes the list and gives the page view back", !vo.isOpen() && !shown() && !(await hiddenNow()).includes("address-suggest"));
		typeText("http://pri");
		await sleep(350);
		check("suggest: web text gets no list", !vo.isOpen());
		typeText("");
		await sleep(200);
		check("suggest: an empty bar gets no list", !vo.isOpen());
		bar().blur();
		// A project without git (a plain walk): the ignored folder is not known there, dot folders and node_modules are still skipped.
		await T("root", { which: "plain" });
		await reset();
		switchTab("browser");
		typeText("skip");
		await until(() => vo.isOpen());
		check("suggest: without git a walk of the folder lists the files (what git ignores is not known there)", JSON.stringify(sug()) === JSON.stringify(["ignored/skip.html"]), JSON.stringify(sug()));
		vo.closeSuggestions();
		typeText("readme");
		await sleep(350);
		check("suggest: the walk never enters node_modules", !vo.isOpen());
		bar().blur();
		await T("root", { which: "project" });
		await reset();
		switchTab("browser");
		console.error(`SELFTEST viewer-open info: git available for the throwaway project: ${S.gitOk}; link (junction) made: ${S.link}`);

		// =============================================================================================================================
		// Task 10: the tree menu and the Editor button
		// =============================================================================================================================
		await reset();
		switchTab("changes");
		await sleep(300);
		let nT = (await list()).tabs.length;
		let row = vo.testTree.open("docs/pricing.html");
		await sleep(250);
		let menu = vo.menu();
		const labels = menu ? [...menu.querySelectorAll("[role=menuitem]")].map((n) => n.textContent) : [];
		check("tree: right-click on a page offers exactly \"Open in Viewer\"", !!menu && labels.length === 1 && labels[0] === "Open in Viewer" && menu.getAttribute("role") === "menu", JSON.stringify(labels));
		check("tree: the menu is on the popover layer and its item has focus", !!menu && getComputedStyle(menu).zIndex === getComputedStyle(document.documentElement).getPropertyValue("--layer-popover").trim() && document.activeElement === menu.querySelector("[role=menuitem]"));
		check("tree: the page view is hidden while the menu is open", (await hiddenNow()).includes("tree-menu"));
		const mr = menu.getBoundingClientRect();
		const hit = document.elementFromPoint(mr.left + mr.width / 2, mr.top + mr.height / 2);
		check("tree: the item is reachable (nothing covers it)", menu.contains(hit), hit && hit.className);
		menu.querySelector("[role=menuitem]").click();
		await until(async () => (await list()).tabs.length === nT + 1);
		await sleep(200);
		l = await list();
		check("tree: choosing it opens the file in a new project tab and shows the Viewer tab", l.tabs.length === nT + 1 && where((await activeTab_()).address) === "docs/pricing.html" && activeTab === "browser" && !vo.menu() && !(await hiddenNow()).includes("tree-menu"), `${l.tabs.length}/${nT + 1} ${activeTab}`);
		const treeTab = l.activeId;
		switchTab("changes");
		await B.createTab(await addr("index.html"));
		nT = (await list()).tabs.length;
		vo.testTree.open("docs/pricing.html");
		await sleep(200);
		vo.menu().querySelector("[role=menuitem]").click();
		await until(async () => (await list()).activeId === treeTab);
		check("tree: a file that a tab already shows is switched to, not opened again", (await list()).activeId === treeTab && (await list()).tabs.length === nT && activeTab === "browser");
		for (const [path, rel] of [["img/logo.svg", "image"], ["brochure.pdf", "pdf"], ["img/photo.png", "image"]]) {
			switchTab("changes");
			vo.testTree.open(path);
			await sleep(200);
			vo.menu()?.querySelector("[role=menuitem]")?.click();
			await until(async () => where((await activeTab_()).address) === path);
			check(`tree: ${path} opens in a ${rel} tab`, where((await activeTab_()).address) === path && (await activeTab_()).kind === rel, (await activeTab_()).kind);
		}
		// No item for what the Viewer does not show: no menu at all.
		for (const [path, why] of [["src/app.js", "a script"], ["notes.txt", "a text file"], ["package.json", "json"], [".hidden/secret.html", "inside a dot folder"], ["node_modules/pkg/readme.html", "inside node_modules"]]) {
			const rw = vo.testTree.make(path);
			const ev = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 40 });
			rw.dispatchEvent(ev);
			await sleep(100);
			check(`tree: no "Open in Viewer" for ${path} (${why}); the right-click is left alone`, !vo.menu() && !ev.defaultPrevented && !(await hiddenNow()).includes("tree-menu"), vo.menu() ? "a menu opened" : "");
			vo.testTree.remove();
		}
		{
			const dirRow = vo.testTree.make("docs");
			dirRow._ent.dir = true;
			const ev = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 40 });
			dirRow.dispatchEvent(ev);
			check("tree: no menu on a folder", !vo.menu() && !ev.defaultPrevented);
			vo.testTree.remove();
		}
		// Keys and outside clicks close it; Escape returns focus to the row.
		row = vo.testTree.open("docs/pricing.html");
		row.tabIndex = 0;
		await sleep(150);
		vo.menu().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
		await sleep(100);
		check("tree: Escape closes the menu, gives the page view back and focus returns to the row", !vo.menu() && !(await hiddenNow()).includes("tree-menu") && document.activeElement === row);
		vo.testTree.open("docs/pricing.html");
		await sleep(150);
		document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
		await sleep(100);
		check("tree: a click outside closes the menu and gives the page view back", !vo.menu() && !(await hiddenNow()).includes("tree-menu"));
		vo.testTree.remove();
		// The real tree: files can be dragged, folders cannot.
		await refreshTree();
		await sleep(300);
		const fileRow = [...document.querySelectorAll("#tree .node")].find((r) => r._ent && !r._ent.dir);
		const dirRow2 = [...document.querySelectorAll("#tree .node")].find((r) => r._ent && r._ent.dir);
		check("tree: a file row is draggable, a folder row is not", !!fileRow && fileRow.draggable === true && (!dirRow2 || dirRow2.draggable !== true), `${fileRow && fileRow.draggable} ${dirRow2 && dirRow2.draggable}`);
		const dsd = new DataTransfer();
		fileRow.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: dsd }));
		check("tree: dragging a file row carries its project path", dsd.getData(TREE()) === fileRow._ent.path, dsd.getData(TREE()));

		// --- the Editor's button ---------------------------------------------------------------------------------------------------------
		const edBtn = () => $("#editor-open-viewer");
		const realEditor = typeof openFile === "function";
		let edOk = false;
		if (realEditor) {
			try {
				await openFile("package.json");
				await sleep(800);
				edOk = typeof edFiles !== "undefined" && edFiles.has("package.json");
			} catch { edOk = false; }
		}
		if (edOk) {
			check("editor: no button for a file the Viewer does not show (package.json)", edBtn().hidden === true && edBtn().dataset.path === "");
			await openFile("src/app-mark.svg");
			await sleep(800);
			switchTab("editor");
			await sleep(400);
			const has = edFiles.has("src/app-mark.svg");
			check("editor: the button shows for an SVG", has && edBtn().hidden === false && edBtn().dataset.path === "src/app-mark.svg" && edBtn().textContent === "Open in Viewer" && edBtn().getClientRects().length > 0, `${has} hidden=${edBtn().hidden}`);
			if (has) {
				nT = (await list()).tabs.length;
				edBtn().click();
				await until(async () => where((await activeTab_()).address) === "src/app-mark.svg");
				l = await list();
				check("editor: the button opens the file in a tab and shows the Viewer tab", where((await activeTab_()).address) === "src/app-mark.svg" && (await activeTab_()).kind === "image" && activeTab === "browser" && l.tabs.length === nT + 1, `${activeTab} ${l.tabs.length}/${nT + 1}`);
				switchTab("editor");
				edBtn().click();
				await sleep(500);
				check("editor: a second press switches to the tab that already shows it", (await list()).tabs.length === nT + 1 && activeTab === "browser");
			}
		} else {
			vo.syncEditorButton("package.json");
			check("editor: no button for a file the Viewer does not show (package.json) [the Editor could not open it here]", edBtn().hidden === true);
			vo.syncEditorButton("src/app-mark.svg");
			check("editor: the button shows for an SVG [the Editor could not open it here]", edBtn().hidden === false && edBtn().dataset.path === "src/app-mark.svg");
			nT = (await list()).tabs.length;
			edBtn().click();
			await until(async () => where((await activeTab_()).address) === "src/app-mark.svg");
			check("editor: the button opens the file in a tab and shows the Viewer tab", where((await activeTab_()).address) === "src/app-mark.svg" && activeTab === "browser", String(activeTab));
		}
		vo.syncEditorButton(".git/x.html");
		check("editor: no button for a file in a dot folder", edBtn().hidden === true);

		// =============================================================================================================================
		// Task 11: drop
		// =============================================================================================================================
		await reset();
		switchTab("browser");
		await sleep(300);
		const hint = () => $("#drop-hint");
		// The hint appears for a file drag, and for a tree drag, while the Viewer tab is shown; not for a text drag.
		drag("dragenter", document.body, dt({ text: "hello" }));
		check("drop: a drag that carries no file shows no hint", !vo.hintShown() && hint().hidden);
		drag("dragenter", document.body, dt({ files: [fileWith("a.html")] }));
		await sleep(150);
		hid = await hiddenNow();
		const hr = hint().getBoundingClientRect();
		const slot = $("#browser-slot").getBoundingClientRect();
		check("drop: a file dragged over the app hides the page view and shows the hint over the Viewer's slot", vo.hintShown() && !hint().hidden && hid.includes("drop") && !(await crust.selftest.bounds()).visible && Math.abs(hr.left - slot.left) < 2 && Math.abs(hr.top - slot.top) < 2 && Math.abs(hr.width - slot.width) < 2, JSON.stringify([hid, hr, slot]));
		check("drop: the hint is on the panel layer and says what to do", getComputedStyle(hint()).zIndex === getComputedStyle(document.documentElement).getPropertyValue("--layer-panel").trim() && /Drop a file/.test(hint().textContent) && /HTML|page/.test(hint().textContent), getComputedStyle(hint()).zIndex);
		await sleep(1300); // no dragover for a while: the drag left the window or ended
		check("drop: the hint goes away by itself when the drag stops (and the view comes back)", !vo.hintShown() && hint().hidden && !(await hiddenNow()).includes("drop"));
		drag("dragenter", document.body, dt({ tree: "docs/pricing.html" }));
		check("drop: a tree drag shows the hint too", vo.hintShown());
		drag("dragend", document.body, dt({ tree: "docs/pricing.html" }));
		await sleep(100);
		check("drop: dragend takes the hint away", !vo.hintShown() && !(await hiddenNow()).includes("drop"));
		switchTab("changes");
		drag("dragenter", document.body, dt({ files: [fileWith("a.html")] }));
		check("drop: no hint while another tab is shown (the page view is not on screen)", !vo.hintShown() && !(await hiddenNow()).includes("drop"));
		switchTab("browser");
		await sleep(200);

		// --- dropping: from the tree, and OS files whose real path is re-checked by main ----------------------------------------------
		const dropOn = async (d) => {
			drag("dragenter", document.body, d);
			await sleep(100);
			drag("dragover", hint(), d);
			const ev = new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: d });
			hint().dispatchEvent(ev);
			await sleep(700);
			return ev;
		};
		await reset();
		nT = (await list()).tabs.length;
		$("#toasts").replaceChildren();
		let ev = await dropOn(dt({ tree: "docs/about-us.html" }));
		l = await list();
		check("drop: a file dragged from the tree opens in a new tab, the hint and the hidden view are gone", ev.defaultPrevented && l.tabs.length === nT + 1 && where((await activeTab_()).address) === "docs/about-us.html" && !vo.hintShown() && !(await hiddenNow()).includes("drop") && (await crust.selftest.bounds()).visible, `${l.tabs.length}/${nT + 1} ${vo.hintShown()} ${JSON.stringify(await hiddenNow())}`);
		const dropTab = l.activeId;
		await B.createTab(await addr("index.html"));
		nT = (await list()).tabs.length;
		await dropOn(dt({ files: [fileWith("about-us.html", abs("docs", "about-us.html"))] }));
		check("drop: an OS file that a tab already shows is switched to (no second tab)", (await list()).activeId === dropTab && (await list()).tabs.length === nT);
		await dropOn(dt({ files: [fileWith("photo.png", abs("img", "photo.png"))] }));
		check("drop: an image from the project opens in an image tab", where((await activeTab_()).address) === "img/photo.png" && (await activeTab_()).kind === "image");
		await dropOn(dt({ files: [fileWith("brochure.pdf", abs("brochure.pdf"))] }));
		check("drop: a PDF from the project opens in a PDF tab", where((await activeTab_()).address) === "brochure.pdf" && (await activeTab_()).kind === "pdf");
		// The refusals: each says why, nothing opens.
		const dropRefusals = [
			["a file outside the project", S.outsideFile, R.outside],
			["a folder", abs("docs"), R.folder],
			["a dot file", abs(".env"), R.dot],
			["a file in a dot folder", abs(".hidden", "secret.html"), R.dot],
			["a kind the Viewer does not show", abs("notes.txt"), R.kind],
			["a file that is not there", abs("docs", "gone.html"), R.missing],
			["a relative path", "docs/pricing.html", R.invalid],
		];
		if (S.link) dropRefusals.push(["a file reached through a link that points outside the project", abs("linkdir", "secret.html"), R.outside]);
		for (const [what, p, why] of dropRefusals) {
			$("#toasts").replaceChildren();
			const before = await list();
			await dropOn(dt({ files: [fileWith(p.split(/[\\/]/).pop(), p)] }));
			const now = await list();
			check(`drop: ${what} is refused with its reason and nothing opens`, toastText().includes(why) && now.tabs.length === before.tabs.length && now.activeId === before.activeId, `toast="${toastText()}" ${now.tabs.length}/${before.tabs.length}`);
		}
		$("#toasts").replaceChildren();
		{
			const before = await list();
			await dropOn(dt({ files: [fileWith("x.html")] })); // no real path: the OS gave none
			check("drop: a file with no real path is refused", toastText().includes(R.invalid) && (await list()).tabs.length === before.tabs.length, toastText());
		}
		// The path check in main, asked directly (what the preload would send): the same answers, and an inside path opens.
		const direct = async (arg) => B.openFile(arg);
		const outs = [["a file outside", { abs: S.outsideFile }, R.outside], ["a relative path out of the project", { rel: "../outside/secret.html" }, R.outside], ["a folder", { abs: abs("docs") }, R.folder], ["a dot file", { rel: ".env" }, R.dot], ["a kind not shown", { rel: "notes.txt" }, R.kind], ["nothing at all", {}, R.invalid], ["a number", { abs: 5 }, R.invalid], ["a NUL in the path", { rel: "index.html\u0000.png" }, R.invalid]];
		if (S.link) outs.push(["through a link pointing outside (abs)", { abs: abs("linkdir", "secret.html") }, R.outside], ["through a link pointing outside (rel)", { rel: "linkdir/secret.html" }, R.outside]);
		for (const [what, arg, why] of outs) {
			const r = await direct(arg);
			check(`main: openFile refuses ${what} ("${why.slice(0, 30)}...")`, r.ok === false && r.message === why, JSON.stringify(r));
		}
		const okr = await direct({ abs: abs("docs", "pricing.html") });
		check("main: openFile opens a real path inside the project", okr.ok === true && okr.path === "docs/pricing.html" && okr.kind === "page", JSON.stringify(okr));
		const okr2 = await direct({ abs: abs("docs", "pricing.html") });
		check("main: the same file again reuses its tab", okr2.ok === true && okr2.reused === true && okr2.tabId === okr.tabId, JSON.stringify(okr2));

		// --- the limit -------------------------------------------------------------------------------------------------------------------
		await reset();
		for (const rel of ["index.html", "docs/pricing.html", "docs/about-us.html", "docs/guide/start.html", "img/logo.svg", "img/photo.png", "brochure.pdf"]) await B.createTab(await addr(rel));
		check("limit: eight tabs open", (await list()).tabs.length === 8, (await list()).tabs.length);
		const lim = await direct({ rel: "many/page01.html" });
		check("limit: a ninth file opens nothing and says why", lim.ok === false && lim.message === R.limit && (await list()).tabs.length === 8, JSON.stringify(lim));
		$("#toasts").replaceChildren();
		await vo.openProject("many/page01.html");
		check("limit: the tree and Editor way shows that reason", toastText().includes(R.limit), toastText());
		await submit("many/page01.html");
		check("limit: in the bar the reason shows in the reason line", (await list()).tabs.length === 8 && (reasonEl().textContent === R.limit || (await activeTab_()).address.includes("page01")), reasonEl().textContent);
		vo.clearRefusal();
		const again = await direct({ rel: "docs/pricing.html" });
		check("limit: an already open file still switches at the limit", again.ok === true && again.reused === true);

		// --- screenshots, light and dark --------------------------------------------------------------------------------------------------
		await reset();
		const saveShot = async (name, what = "win") => (await T("shot", { name, what })).ok;
		const shotLog = [];
		for (const th of ["light", "dark"]) {
			setTheme(th);
			await sleep(600);
			await B.createTab(await addr("docs/pricing.html"));
			await until(async () => bar().value === "docs/pricing.html");
			bar().blur();
			await sleep(500);
			shotLog.push(await saveShot(`vo-bar-path-${th}`));
			typeText("doc");
			await until(() => vo.isOpen());
			press("ArrowDown");
			await sleep(300);
			shotLog.push(await saveShot(`vo-suggest-${th}`));
			press("Escape");
			bar().blur();
			await submit("../outside/secret.html");
			await sleep(300);
			shotLog.push(await saveShot(`vo-refusal-${th}`));
			vo.clearRefusal();
			bar().blur();
			switchTab("changes");
			await sleep(300);
			const sr = vo.testTree.open("docs/pricing.html");
			await sleep(300);
			shotLog.push(await saveShot(`vo-tree-menu-${th}`));
			vo.testTree.close();
			if (edOk) {
				switchTab("editor");
				await openFile("src/app-mark.svg");
				await sleep(700);
				shotLog.push(await saveShot(`vo-editor-button-${th}`));
			}
			switchTab("browser");
			await sleep(300);
			drag("dragenter", document.body, dt({ files: [fileWith("a.html")] }));
			await sleep(300);
			shotLog.push(await saveShot(`vo-drop-hint-${th}`));
			vo.hideHint();
			$("#toasts").replaceChildren();
			await dropOn(dt({ files: [fileWith("secret.html", S.outsideFile)] }));
			await sleep(200);
			shotLog.push(await saveShot(`vo-drop-refusal-${th}`));
			$("#toasts").replaceChildren();
			void sr;
			await reset();
		}
		setTheme("light");
		console.error(`SELFTEST viewer-open screenshots: ${shotLog.filter(Boolean).length} of ${shotLog.length} saved${shotLog.every(Boolean) ? "" : " (PI_CRUST_VO_SHOTDIR not set?)"}`);
	} catch (e) {
		check("no exception", false, e && e.stack ? e.stack : e);
	} finally {
		await reset().catch(() => {});
		await T("stop").catch(() => {});
	}
	const bad = checks.filter((c) => !c.ok).length;
	console.error(`SELFTEST viewer-open: ${checks.length} checks, ${bad ? bad + " MISMATCH" : "all OK"}`);
}, "viewer-open");
