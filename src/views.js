// Views: All, Dev, Design. A view decides which tabs and tools are visible; the panel layout is remembered per view.
"use strict";

// One table per view. tabs: visible middle tabs; hide: selectors hidden in this view; tab: default tab;
// panels: layout the first time the view is entered; noBottom: the terminal can't dock at the bottom.
const VIEWS = {
	all: {
		label: "All",
		description: "Everything: editor, changes, browser, terminal and design tools",
		tabs: ["editor", "changes", "browser", "terminal", "design"],
		hide: [],
		tab: null, // first visible tab
		panels: { left: true, right: true, bottom: false },
	},
	dev: {
		label: "Dev",
		description: "Code: editor, changes, browser and terminal",
		tabs: ["editor", "changes", "browser", "terminal"],
		hide: ["#tweak-btn", "#annotate-btn", "#pick-figma", "#story-bar", "#timeline"],
		tab: "editor",
		panels: { left: true, right: true, bottom: false },
	},
	design: {
		label: "Design",
		description: "Design: browser, design tools and changes. No editor or terminal",
		tabs: ["browser", "design", "changes"],
		hide: ['[data-action="devtools"]', "#toggle-bottom", "#bottom-panel", "#bottom-splitter"],
		tab: "browser",
		panels: { left: false, right: true, bottom: false },
		noBottom: true,
	},
};
const VIEW_ORDER = Object.keys(VIEWS);

let currentView = (() => {
	const v = localStorage.getItem("view");
	return VIEWS[v] ? v : "all";
})();
let transientTab = null; // a hidden tab opened on purpose, shown until the user leaves it

// "all" keeps the original "panels" key, so current users keep their layout.
const panelsKey = (v = currentView) => (v === "all" ? "panels" : `panels:${v}`);
const viewDef = () => VIEWS[currentView];

function loadPanels(v) {
	try {
		const saved = JSON.parse(localStorage.getItem(panelsKey(v)) || "null");
		if (saved) return { ...VIEWS[v].panels, ...saved };
	} catch {}
	return { ...VIEWS[v].panels };
}

// Start in the saved view's layout (layout.js read the "panels" key before we knew the view).
if (currentView !== "all") Object.assign(panelState, loadPanels(currentView));
if (viewDef().noBottom) panelState.bottom = false;

// Tabs in tab order that the current view shows; ⌘1…⌘5, the "Go to" commands and the startup tab use this.
const visibleTabs = () => tabOrder.filter((t) => viewDef().tabs.includes(t));
const viewStartTab = () => viewDef().tab || visibleTabs()[0];
const goTab = (i) => visibleTabs()[i] && switchTab(visibleTabs()[i]);

// Called by switchTab: a tab outside the view shows temporarily while it's active.
function syncTransientTab(name) {
	transientTab = viewDef().tabs.includes(name) ? null : name;
	for (const b of document.querySelectorAll(".tabs [data-tab]")) b.classList.toggle("transient", b.dataset.tab === transientTab);
}

// Hiding is CSS keyed on body[data-view], so features that toggle [hidden] themselves can't undo it.
function injectViewCss() {
	const rules = [];
	for (const [id, v] of Object.entries(VIEWS)) {
		const sel = [...TAB_DEFAULT_ORDER.filter((t) => !v.tabs.includes(t)).map((t) => `.tabs [data-tab="${t}"]:not(.transient)`), ...v.hide];
		if (sel.length) rules.push(`${sel.map((s) => `body[data-view="${id}"] ${s}`).join(",\n")} { display: none !important; }`);
	}
	const style = document.createElement("style");
	style.textContent = rules.join("\n");
	document.head.append(style);
}

const SVG_OPEN = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">';
const VIEW_ICONS = {
	all: '<rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/><rect x="2" y="9" width="5" height="5" rx="1"/><rect x="9" y="9" width="5" height="5" rx="1"/>',
	dev: '<path d="M5.5 4.5L2 8l3.5 3.5M10.5 4.5L14 8l-3.5 3.5M9 3L7 13"/>',
	design: '<path d="M11.5 2.5l2 2L6.5 11.5l-3 1 1-3z"/><path d="M10 4l2 2"/>',
};
const viewIcon = (id) => SVG_OPEN + VIEW_ICONS[id] + "</svg>";
const viewTitle = (id) => keyLabel(`View: ${VIEWS[id].label} (⌃⌘${VIEW_ORDER.indexOf(id) + 1})`);
let viewBtn = null;
let viewMenu = null;

function paintViewSwitch() {
	if (!viewBtn) return;
	viewBtn.innerHTML = viewIcon(currentView);
	viewBtn.dataset.view = currentView;
	viewBtn.title = viewBtn.ariaLabel = viewTitle(currentView);
	for (const r of viewMenu?.querySelectorAll("[role=menuitemradio]") || []) r.setAttribute("aria-checked", String(r.dataset.view === currentView));
}

function closeViewMenu({ focus = true } = {}) {
	if (!viewMenu) return;
	viewMenu.remove();
	viewMenu = null;
	removeEventListener("pointerdown", onViewOutside, true);
	removeEventListener("keydown", onViewKey, true);
	viewBtn.setAttribute("aria-expanded", "false");
	crust.browser.hide(false, "view-menu");
	if (focus) viewBtn.focus();
}
function onViewOutside(e) {
	if (!viewMenu.contains(e.target) && !viewBtn.contains(e.target)) closeViewMenu({ focus: false });
}
function onViewKey(e) {
	const items = [...viewMenu.querySelectorAll("[role=menuitemradio]")];
	const i = items.indexOf(document.activeElement);
	const move = (n) => {
		e.preventDefault();
		e.stopPropagation();
		items[(n + items.length) % items.length].focus();
	};
	if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeViewMenu(); }
	else if (e.key === "ArrowDown") move(i + 1);
	else if (e.key === "ArrowUp") move(i < 0 ? -1 : i - 1);
	else if (e.key === "Home") move(0);
	else if (e.key === "End") move(items.length - 1);
	else if (e.key === "Tab") closeViewMenu();
}

function openViewMenu() {
	closeViewMenu({ focus: false });
	viewMenu = el("div", "slash-menu wt-menu view-menu");
	viewMenu.setAttribute("role", "menu");
	viewMenu.setAttribute("aria-label", "View");
	for (const id of VIEW_ORDER) {
		const row = el("button", "pal-item");
		row.type = "button";
		row.dataset.view = id;
		row.setAttribute("role", "menuitemradio");
		row.setAttribute("aria-checked", String(id === currentView));
		const ico = el("span", "vm-icon");
		ico.innerHTML = viewIcon(id);
		const text = el("span", "vm-text");
		text.append(el("span", "label", VIEWS[id].label), el("span", "desc", VIEWS[id].description));
		const k = el("kbd", "", keyLabel(`⌃⌘${VIEW_ORDER.indexOf(id) + 1}`));
		const check = el("span", "vm-check", "✓");
		check.setAttribute("aria-hidden", "true");
		row.append(ico, text, k, check);
		row.onclick = () => {
			setView(id);
			closeViewMenu();
		};
		viewMenu.append(row);
	}
	crust.browser.hide(true, "view-menu"); // the browser view is drawn above HTML and would cover the menu
	document.body.append(viewMenu);
	const r = viewBtn.getBoundingClientRect();
	viewMenu.style.top = `${r.bottom + 4}px`;
	viewMenu.style.left = `${Math.max(8, r.right - viewMenu.offsetWidth)}px`;
	viewBtn.setAttribute("aria-expanded", "true");
	viewMenu.querySelector("[aria-checked=true]").focus();
	addEventListener("pointerdown", onViewOutside, true);
	addEventListener("keydown", onViewKey, true);
}

function setView(name, { initial = false } = {}) {
	if (!VIEWS[name] || (name === currentView && !initial)) return;
	currentView = name;
	localStorage.setItem("view", name);
	document.body.dataset.view = name;
	paintViewSwitch();
	applyTabOrder(); // refreshes the ⌘n labels for the visible tabs
	if (initial) return; // initLayout and initChanges apply the saved layout and tab
	// Restore this view's panels (savePanels now writes to its key), then go to a visible tab.
	const s = loadPanels(name);
	setPane("left", s.left);
	setPane("right", s.right);
	setBottom(viewDef().noBottom ? false : s.bottom);
	if (!visibleTabs().includes(activeTab) || (transientTab && activeTab !== transientTab)) switchTab(viewStartTab());
	else syncTransientTab(activeTab);
	requestAnimationFrame(() => {
		syncBrowserBounds();
		fitTerminal();
	});
}

function initViews() {
	injectViewCss();
	document.body.dataset.view = currentView;
	viewBtn = el("button", "icon view-btn");
	viewBtn.type = "button";
	viewBtn.id = "view-btn";
	viewBtn.setAttribute("aria-haspopup", "menu");
	viewBtn.setAttribute("aria-expanded", "false");
	viewBtn.onclick = () => (viewMenu ? closeViewMenu() : openViewMenu());
	$(".tabs .layout-toggles").prepend(viewBtn);
	paintViewSwitch();
	setView(currentView, { initial: true });

	// ⌃⌘1 / ⌃⌘2 / ⌃⌘3 (Ctrl+Alt on Windows).
	window.addEventListener(
		"keydown",
		(e) => {
			if (dialogOpen || e.shiftKey || !(isMac ? e.metaKey && e.ctrlKey && !e.altKey : e.ctrlKey && e.altKey && !e.metaKey)) return;
			const id = VIEW_ORDER[Number(e.code.replace("Digit", "")) - 1];
			if (!id) return;
			e.preventDefault();
			e.stopPropagation();
			closePalette?.();
			setView(id);
		},
		true,
	);
}
window.setView = setView;

// --- selftest: every view shows its tabs and hides its tools --------------------------------------
selftestSteps.push(async ({ snap, wait }) => {
	const shown = (n) => !!n && getComputedStyle(n).display !== "none";
	try {
		for (const id of VIEW_ORDER) {
			setView(id);
			await wait(600);
			const v = VIEWS[id];
			const tabs = [...document.querySelectorAll(".tabs [data-tab]")].filter(shown).map((b) => b.dataset.tab);
			const hiddenOk = v.hide.every((s) => [...document.querySelectorAll(s)].every((n) => !shown(n)));
			const tabsOk = tabs.join() === visibleTabs().join() && tabs.length === v.tabs.length;
			const kbd = [...document.querySelectorAll(".tabs [data-tab] kbd")].filter(shown).map((k) => k.textContent).join(" ");
			const checked = document.body.dataset.view === id && viewBtn.title.includes(`View: ${v.label}`) && viewBtn.getAttribute("aria-haspopup") === "menu" && viewBtn.dataset.view === id;
			const tabOk = activeTab === viewStartTab() || visibleTabs().includes(activeTab);
			const bottomOk = !v.noBottom || (!panelState.bottom && !shown($("#bottom-panel")));
			console.error(`SELFTEST views: ${id} tabs=${tabs.join(",")} active=${activeTab} kbd=${kbd} hidden=${hiddenOk} -> ${tabsOk && hiddenOk && checked && tabOk && bottomOk ? "OK" : "MISMATCH"}`);
			await snap(`view-${id}`);
		}
		// The menu: opens under the button, current view checked, arrows + Enter pick, Esc closes and refocuses.
		setView("dev");
		await wait(700); // let the panel animation settle so the menu anchors to the final button position
		viewBtn.click();
		await wait(200);
		const items = [...(viewMenu?.querySelectorAll("[role=menuitemradio]") || [])];
		const checkedNow = items.filter((r) => r.getAttribute("aria-checked") === "true").map((r) => r.dataset.view).join();
		const openOk = items.length === 3 && checkedNow === "dev" && viewBtn.getAttribute("aria-expanded") === "true" && document.activeElement === items[1];
		await snap("view-menu");
		const key = (k) => document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
		items[1].focus(); // the screenshot may have taken focus
		key("ArrowDown");
		const moved = document.activeElement === items[2];
		key("Escape");
		const escOk = !viewMenu && document.activeElement === viewBtn && viewBtn.getAttribute("aria-expanded") === "false";
		viewBtn.click();
		await wait(100);
		viewMenu.querySelector('[data-view="design"]').click();
		await wait(300);
		const pickOk = currentView === "design" && !viewMenu && viewBtn.title.includes("Design");
		console.error(`SELFTEST views: menu open=${openOk} arrows=${moved} esc=${escOk} pick=${pickOk} -> ${openOk && moved && escOk && pickOk ? "OK" : "MISMATCH"}`);
		// A hidden tab opened by code shows temporarily, then goes away again.
		setView("design");
		switchTab("editor");
		const on = shown(tabButton("editor")) && tabButton("editor").classList.contains("transient");
		switchTab("browser");
		const off = !shown(tabButton("editor"));
		console.error(`SELFTEST views: transient editor tab shown=${on} gone after leaving=${off} -> ${on && off ? "OK" : "MISMATCH"}`);
	} finally {
		setView("all");
		await wait(400);
	}
});
