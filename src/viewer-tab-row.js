// The Viewer's page tabs, the row under the address bar (spec: Viewer tabs and project files, section B; task 5). The main process owns the
// tabs (viewer-tabs-main.js: IPC browser:tabs / tabCreate / tabActivate / tabClose, and browser:state with tabId, activeId and tabs); this file
// only draws them and sends the person's clicks and keys.
//
// The native page view is drawn above the DOM, so the row sits OUTSIDE its slot: #browser-slot starts below the row and the view's bounds
// follow the slot, which shrinks by the row's height. Nothing in the row is a popup over the view: the reason for the disabled `+` appears
// inside the row, not below it.
//
// Keys (only while the Viewer tab is shown): Ctrl/Cmd+T new page, Ctrl/Cmd+W close the page, Alt+Ctrl/Alt+Cmd+Left and Right previous and next.
// They are also forwarded from the page view (viewer-tabs-main.js, before-input-event) because the view swallows keys while it has focus.
"use strict";

(() => {
	const MAX = 8;
	const LIMIT_REASON = "8 pages is the most. Close one first.";
	const LABEL_MAX = 24;
	const row = $("#viewer-tabs");
	const listEl = $("#vt-list");
	const addBtn = $("#vt-add");
	const limitEl = $("#vt-limit");
	let tabs = [];
	let activeId = null;
	const items = new Map(); // tab id -> { item, tabBtn, mark, label, close }

	const ICONS = {
		page: '<path d="M4 1.5h5l3 3v10H4z"/><path d="M9 1.5v3h3"/>',
		image: '<rect x="2" y="3" width="12" height="10" rx="1.5"/><circle cx="5.75" cy="6.5" r="1"/><path d="M2.5 12l3.5-3.5 2.5 2.5 2-2 3 3"/>',
		pdf: '<path d="M4 1.5h5l3 3v10H4z"/><path d="M9 1.5v3h3"/><path d="M6 11h4"/><path d="M6 8.5h2"/>',
	};
	const KIND_NAME = { page: "page", image: "image", pdf: "PDF" };
	const svg = (inner) => `<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;

	const isProject = (t) => typeof t.session === "string" && t.session.startsWith("project:");
	// The project path of a pi-project address, as the address bar would show it ("docs/pricing.html").
	function projectPath(address) {
		try {
			const u = new URL(address);
			return decodeURIComponent(u.pathname).replace(/^\/+/, "");
		} catch {
			return "";
		}
	}
	// Page title, else file name, else host.
	function titleOf(t) {
		const title = String(t.title || "").trim();
		if (title) return title;
		const address = t.address || "";
		if (/^pi-project:/i.test(address)) {
			const segs = projectPath(address).split("/").filter(Boolean);
			if (segs.length) return segs[segs.length - 1];
		}
		try {
			const h = new URL(address).host;
			if (h) return h;
		} catch {
			/* not an address */
		}
		return "New page";
	}
	function shorten(s) {
		const chars = [...s];
		return chars.length > LABEL_MAX ? chars.slice(0, LABEL_MAX - 1).join("") + "…" : s;
	}
	const tooltipOf = (t) => {
		const where = isProject(t) ? projectPath(t.address) : t.address || "";
		const full = titleOf(t);
		return where && where !== full ? `${full}\n${where}` : full;
	};
	const nameOf = (t) => {
		const parts = [titleOf(t)];
		if (isProject(t)) parts.push(KIND_NAME[t.kind] || "page");
		if (t.loading) parts.push("loading");
		if (t.error) parts.push("could not load");
		return parts.join(", ");
	};

	function build(id) {
		const item = el("div", "vt-item");
		item.setAttribute("role", "presentation");
		item.dataset.id = id;
		const tabBtn = el("button", "vt-tab");
		tabBtn.type = "button";
		tabBtn.setAttribute("role", "tab");
		tabBtn.id = `vt-tab-${id}`;
		const mark = el("span", "vt-mark");
		mark.setAttribute("aria-hidden", "true");
		const label = el("span", "vt-label");
		tabBtn.append(mark, label);
		const close = el("button", "vt-close", "×");
		close.type = "button";
		close.tabIndex = -1; // reached with Delete from the tab; a click still works
		tabBtn.addEventListener("click", () => activate(id));
		close.addEventListener("click", (e) => {
			e.stopPropagation();
			closeTab(id);
		});
		item.addEventListener("mousedown", (e) => e.button === 1 && e.preventDefault()); // no autoscroll
		item.addEventListener("auxclick", (e) => {
			if (e.button !== 1) return;
			e.preventDefault();
			closeTab(id);
		});
		tabBtn.addEventListener("keydown", (e) => onTabKey(e, id));
		item.append(tabBtn, close);
		const entry = { item, tabBtn, mark, label, close, kind: null };
		items.set(id, entry);
		return entry;
	}

	function render() {
		const focusedId = row.contains(document.activeElement) ? document.activeElement.closest(".vt-item")?.dataset.id : null;
		const keep = new Set(tabs.map((t) => t.id));
		for (const [id, e] of [...items]) {
			if (keep.has(id)) continue;
			e.item.remove();
			items.delete(id);
		}
		tabs.forEach((t, i) => {
			const e = items.get(t.id) || build(t.id);
			const full = titleOf(t);
			const shown = shorten(full);
			if (e.label.textContent !== shown) e.label.textContent = shown;
			e.item.title = tooltipOf(t);
			const active = t.id === activeId;
			e.item.classList.toggle("active", active);
			e.item.classList.toggle("loading", !!t.loading);
			e.item.classList.toggle("failed", !!t.error);
			e.tabBtn.setAttribute("aria-selected", String(active));
			e.tabBtn.tabIndex = active ? 0 : -1; // roving focus: one stop in the row
			e.tabBtn.setAttribute("aria-label", nameOf(t));
			e.close.setAttribute("aria-label", `Close ${full}`);
			e.close.title = "Close page";
			// The mark: a spinner while loading, else the kind of a project file (nothing for a web page).
			const markKey = t.loading ? "loading" : isProject(t) ? t.kind || "page" : "";
			if (e.kind !== markKey) {
				e.kind = markKey;
				e.mark.innerHTML = markKey === "loading" ? '<span class="vt-spin"></span>' : markKey ? svg(ICONS[markKey] || ICONS.page) : "";
				e.mark.hidden = !markKey;
				e.mark.dataset.kind = markKey;
			}
			if (listEl.children[i] !== e.item) listEl.insertBefore(e.item, listEl.children[i] || null);
		});
		listEl.dataset.count = String(tabs.length);
		row.classList.toggle("vt-single", tabs.length <= 1);
		const full = tabs.length >= MAX;
		addBtn.setAttribute("aria-disabled", String(full));
		addBtn.title = full ? LIMIT_REASON : keyLabel("New page (⌘T)");
		limitEl.textContent = LIMIT_REASON;
		limitEl.hidden = !full;
		if (full) addBtn.setAttribute("aria-describedby", "vt-limit");
		else addBtn.removeAttribute("aria-describedby");
		const a = items.get(activeId);
		if (a && focusedId && !items.has(focusedId)) a.tabBtn.focus(); // the focused page was closed: focus goes to the active one
		revealActive();
	}

	// The active tab is always fully in view: after it changes, after a tab is added or closed, and whenever the list's width changes (a
	// window resize, a reason shown at the right end of the row; see the ResizeObserver below). The list is scrolled by its own scrollLeft:
	// scrollIntoView would also move the row. Next to a cut-off side the tab keeps clear of the fade (FADE px).
	const FADE = 24;
	function revealActive() {
		const a = items.get(activeId);
		if (!a || !a.item.offsetParent) return;
		const lr = listEl.getBoundingClientRect();
		const ir = a.item.getBoundingClientRect();
		const w = listEl.clientWidth;
		const maxLeft = Math.max(0, listEl.scrollWidth - w);
		const x0 = ir.left - lr.left + listEl.scrollLeft; // the tab's edges in the scrolled content
		const x1 = x0 + ir.width;
		let t = listEl.scrollLeft;
		if (ir.width + 2 * FADE > w) t = x0 - 3; // no room for the fades: show the tab from its left edge
		else if (x0 - FADE < t) t = x0 - FADE;
		else if (x1 + FADE > t + w) t = x1 + FADE - w;
		t = Math.max(0, Math.min(maxLeft, t));
		if (Math.abs(t - listEl.scrollLeft) > 0.5) listEl.scrollLeft = t;
		updateFade();
	}
	// The cut-off side of a scrolling list fades out (CSS: #vt-list[data-fade]).
	function updateFade() {
		const more = listEl.scrollWidth - listEl.clientWidth > 1;
		const l = more && listEl.scrollLeft > 1;
		const r = more && listEl.scrollLeft + listEl.clientWidth < listEl.scrollWidth - 1;
		const v = l && r ? "both" : l ? "left" : r ? "right" : "";
		if ((listEl.dataset.fade || "") !== v) {
			if (v) listEl.dataset.fade = v;
			else delete listEl.dataset.fade;
		}
	}
	listEl.addEventListener("scroll", updateFade, { passive: true });
	if (typeof ResizeObserver === "function") new ResizeObserver(() => revealActive()).observe(listEl);

	function apply(s) {
		if (!s || !Array.isArray(s.tabs)) return;
		tabs = s.tabs;
		activeId = s.activeId;
		render();
	}

	async function activate(id) {
		if (id === activeId) return;
		apply(await crust.browser.activateTab(id));
	}
	async function closeTab(id) {
		const had = row.contains(document.activeElement);
		const r = await crust.browser.closeTab(id);
		apply(r);
		if (had) items.get(activeId)?.tabBtn.focus();
	}
	// `+` and Ctrl/Cmd+T. At the limit nothing opens; the reason shows (focus goes to `+`, so the reason is read out and drawn).
	async function addTab() {
		if (tabs.length >= MAX) {
			addBtn.focus();
			return { ok: false, reason: "limit" };
		}
		const r = await crust.browser.createTab();
		if (r && r.ok) {
			apply(r);
			const url = $("#url");
			url.value = r.url || "";
			url.focus();
			url.select();
		}
		return r;
	}
	function step(dir) {
		if (tabs.length < 2) return;
		const i = tabs.findIndex((t) => t.id === activeId);
		const next = tabs[(i + dir + tabs.length) % tabs.length];
		return activate(next.id);
	}
	function onTabKey(e, id) {
		const i = tabs.findIndex((t) => t.id === id);
		let to = null;
		if (e.altKey || e.ctrlKey || e.metaKey) return;
		if (e.key === "ArrowRight") to = tabs[(i + 1) % tabs.length];
		else if (e.key === "ArrowLeft") to = tabs[(i - 1 + tabs.length) % tabs.length];
		else if (e.key === "Home") to = tabs[0];
		else if (e.key === "End") to = tabs[tabs.length - 1];
		else if (e.key === "Delete") {
			e.preventDefault();
			closeTab(id);
			return;
		} else return;
		e.preventDefault();
		if (!to) return;
		items.get(to.id)?.tabBtn.focus();
		activate(to.id); // arrows switch the page as they move (the pages are cheap to show)
	}

	addBtn.addEventListener("click", () => {
		addTab();
	});

	// Keys. Capture phase, like the other app shortcuts; forwarded ones from the page view arrive as synthetic keydown events.
	window.addEventListener(
		"keydown",
		(e) => {
			if (activeTab !== "browser" || dialogOpen) return; // only while the Viewer tab is shown
			if (e.target?.closest?.(".xterm")) return;
			const k = (e.key || "").toLowerCase();
			const mod = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
			if (!mod || e.shiftKey) return;
			let run = null;
			if (!e.altKey && k === "t") run = () => addTab();
			else if (!e.altKey && k === "w") run = () => closeTab(activeId);
			else if (e.altKey && k === "arrowleft") run = () => step(-1);
			else if (e.altKey && k === "arrowright") run = () => step(1);
			if (!run) return;
			e.preventDefault();
			e.stopPropagation();
			run();
		},
		true,
	);

	crust.browser.onState(apply);
	crust.browser.tabs().then(apply);

	window.crustViewerRow = { MAX, LIMIT_REASON, titleOf, shorten, tooltipOf, add: addTab, close: closeTab, step, activate, state: () => ({ tabs, activeId }), items: () => items };
})();
