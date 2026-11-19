// Opening a project file in the Viewer, the UI (spec: Viewer tabs and project files, tasks 9 to 11). Three ways in, one door in main
// (viewer-open-main.js, which checks every path again): the address bar, the file tree's menu and the Editor's button, and a drop.
//
//  Address bar   a project file shows as its plain project path ("docs/pricing.html"), never the internal pi-project:// address; Enter on
//                a path opens the file; text that is refused (viewer-open-logic.js has the reasons) gets them in the tab row's reason line
//                and a red outline on the bar, which go away on the next keystroke, Escape or a switch of tab. Suggestions while typing: at
//                most 8 project files, a popover (the named popover layer) under the bar; it hides the native page view while it is open
//                (the view is drawn above the DOM) and closes on Escape, blur and a choice. Keys: Up and Down, Enter.
//  Tree, Editor  "Open in Viewer" in the tree's right-click menu (only for a file of a kind the Viewer shows) and a small button in the
//                Editor's status bar for the open file; both open the file in a tab (the one that already shows it, else a new one) and
//                show the Viewer tab.
//  Drop          a file dragged from the tree, Explorer or Finder onto the Viewer opens. While such a drag is over the app and the Viewer
//                tab is shown, the page view is hidden and a hint covers it, or the view would swallow the drop. The real path of an OS
//                file comes from webUtils.getPathForFile (preload); main re-checks it. A refusal says why and nothing opens.
"use strict";

(() => {
	const VK = window.ViewerKind;
	const TREE_TYPE = "application/x-pi-crust-path"; // a tree row's project path while it is dragged
	const input = $("#url");
	const reasonEl = $("#vt-reason");
	const MAX_ITEMS = 8;

	// --- the address bar: what it shows ---------------------------------------------------------------------------------------
	// The project path of a pi-project address, "docs/pricing.html"; anything else is shown as it is.
	function display(address) {
		const a = String(address || "");
		if (!/^pi-project:/i.test(a)) return a;
		try {
			return decodeURIComponent(new URL(a).pathname).replace(/^\/+/, "") || a;
		} catch {
			return a;
		}
	}

	// --- refusals ---------------------------------------------------------------------------------------------------------------
	// The reason goes where the other reasons of the Viewer go: the line inside the tab row (a popup below the bar would sit under the native
	// page view). The bar is outlined and described by it.
	function refuse(message) {
		input.setAttribute("aria-invalid", "true");
		input.setAttribute("aria-describedby", "vt-reason");
		reasonEl.textContent = message;
		reasonEl.dataset.for = "address";
		reasonEl.classList.add("show");
	}
	function clearRefusal() {
		if (input.getAttribute("aria-invalid") !== "true") return;
		input.removeAttribute("aria-invalid");
		input.removeAttribute("aria-describedby");
		if (reasonEl.dataset.for === "address") {
			reasonEl.classList.remove("show");
			reasonEl.textContent = "";
			reasonEl.dataset.for = "";
		}
	}

	// A page the APP could not open (a story, the Mendix app or a chat link with no tab free: "8 pages is the most. Close one first."): main says
	// it in this same line. It goes away by itself, or when the address bar's own refusal takes the line.
	let noticeTimer = 0;
	crust.browser.onNotice?.((n) => {
		if (!n || !n.message) return;
		clearTimeout(noticeTimer);
		reasonEl.textContent = n.message;
		reasonEl.dataset.for = "notice";
		reasonEl.classList.add("show");
		noticeTimer = setTimeout(() => {
			if (reasonEl.dataset.for !== "notice") return;
			reasonEl.classList.remove("show");
			reasonEl.textContent = "";
			reasonEl.dataset.for = "";
		}, 6000);
	});

	// Enter: close the list, ask main. Main decides (a project file, a web address, or a refusal with its reason).
	async function go(text) {
		close();
		clearRefusal();
		let r;
		try {
			r = await crust.browser.navigate(text);
		} catch {
			return;
		}
		if (r && r.ok === false && r.message) refuse(r.message);
		return r;
	}

	// --- suggestions ------------------------------------------------------------------------------------------------------------
	let list = null; // the popover, built on first use
	let items = [];
	let hi = -1; // the highlighted item
	let isOpen = false;
	let seq = 0;
	let timer = 0;
	const split = (p) => {
		const i = p.lastIndexOf("/");
		return { name: p.slice(i + 1), dir: i < 0 ? "" : p.slice(0, i) };
	};
	function build() {
		if (list) return list;
		list = el("div", "slash-menu url-suggest");
		list.id = "url-suggest";
		list.setAttribute("role", "listbox");
		list.setAttribute("aria-label", "Project files");
		list.hidden = true;
		// A mouse press must not blur the bar (that would close the list before the click lands).
		list.addEventListener("mousedown", (e) => e.preventDefault());
		list.addEventListener("click", (e) => {
			const n = e.target.closest(".pal-item");
			if (n) choose(Number(n.dataset.i));
		});
		list.addEventListener("mousemove", (e) => {
			const n = e.target.closest(".pal-item");
			if (n && Number(n.dataset.i) !== hi) highlight(Number(n.dataset.i));
		});
		document.body.append(list);
		return list;
	}
	function place() {
		const r = input.getBoundingClientRect();
		list.style.left = `${Math.round(r.left)}px`;
		list.style.top = `${Math.round(r.bottom + 4)}px`;
		list.style.minWidth = `${Math.round(r.width)}px`;
		list.style.maxWidth = `${Math.max(240, Math.round(innerWidth - r.left - 8))}px`;
	}
	function render() {
		build();
		list.replaceChildren(
			...items.map((it, i) => {
				const { name, dir } = split(it.path);
				const row = el("div", `pal-item${i === hi ? " active" : ""}`);
				row.id = `url-suggest-${i}`;
				row.dataset.i = String(i);
				row.setAttribute("role", "option");
				row.setAttribute("aria-selected", String(i === hi));
				row.title = it.path;
				row.append(el("span", "kind", it.kind === "page" ? "page" : it.kind), el("span", "label", name), el("span", "desc", dir));
				return row;
			}),
		);
		input.setAttribute("aria-activedescendant", hi >= 0 ? `url-suggest-${hi}` : "");
		if (hi < 0) input.removeAttribute("aria-activedescendant");
	}
	function show(found) {
		items = found.slice(0, MAX_ITEMS);
		if (!items.length) return close();
		hi = -1;
		render();
		place();
		list.hidden = false;
		input.setAttribute("aria-expanded", "true");
		input.setAttribute("aria-controls", "url-suggest");
		if (!isOpen) {
			isOpen = true;
			crust.browser.hide(true, "address-suggest"); // the page view is drawn above the DOM: hide it while the list is open
		}
	}
	function close() {
		clearTimeout(timer);
		seq++; // an answer still on its way is dropped
		if (list) list.hidden = true;
		items = [];
		hi = -1;
		input.removeAttribute("aria-activedescendant");
		input.setAttribute("aria-expanded", "false");
		if (isOpen) {
			isOpen = false;
			crust.browser.hide(false, "address-suggest");
		}
	}
	function highlight(i) {
		hi = items.length ? (i + items.length) % items.length : -1;
		render();
		list.children[hi]?.scrollIntoView({ block: "nearest" });
	}
	function choose(i) {
		const it = items[i];
		if (!it) return;
		input.value = it.path;
		go(it.path);
	}
	function ask() {
		clearTimeout(timer);
		const mine = ++seq;
		const text = input.value;
		if (!text.trim()) return close();
		timer = setTimeout(async () => {
			let r;
			try {
				r = await crust.browser.suggest(text);
			} catch {
				r = null;
			}
			if (mine !== seq || document.activeElement !== input) return; // a newer keystroke, or the bar lost focus meanwhile
			show((r && r.items) || []);
		}, 50);
	}

	input.setAttribute("role", "combobox");
	input.setAttribute("aria-autocomplete", "list");
	input.setAttribute("aria-expanded", "false");
	input.addEventListener("input", () => {
		clearRefusal();
		ask();
	});
	input.addEventListener("keydown", (e) => {
		if (e.key === "ArrowDown" || e.key === "ArrowUp") {
			if (!isOpen) return e.key === "ArrowDown" && input.value.trim() && (e.preventDefault(), ask());
			e.preventDefault();
			highlight(hi < 0 ? (e.key === "ArrowDown" ? 0 : items.length - 1) : hi + (e.key === "ArrowDown" ? 1 : -1));
		} else if (e.key === "Enter" && isOpen && hi >= 0) {
			e.preventDefault();
			choose(hi);
		} else if (e.key === "Escape") {
			if (isOpen) {
				e.preventDefault();
				e.stopPropagation();
				close();
			} else if (input.getAttribute("aria-invalid") === "true") clearRefusal();
		} else if (e.key === "Tab") close();
	});
	input.addEventListener("blur", close);
	window.addEventListener("resize", () => isOpen && close());

	// --- the tree's menu and the Editor's button ----------------------------------------------------------------------------------
	// The Viewer opens only files inside the project: the tree is the project. A path the Viewer may show: viewer-kind.js.
	async function openProject(rel) {
		let r;
		try {
			r = await crust.browser.openFile({ rel });
		} catch {
			r = null;
		}
		if (r && r.ok) {
			switchTab("browser");
			return r;
		}
		toast((r && r.message) || "That path can't be shown here.", "warning");
		return r;
	}

	let menu = null;
	let menuReturn = null; // the row to focus again when the menu closes by keyboard
	function closeMenu({ restore = false } = {}) {
		if (!menu) return;
		menu.remove();
		menu = null;
		document.removeEventListener("pointerdown", onOutside, true);
		window.removeEventListener("blur", onWindowBlur);
		crust.browser.hide(false, "tree-menu");
		if (restore && menuReturn?.isConnected) menuReturn.focus();
		menuReturn = null;
	}
	const onOutside = (e) => {
		if (menu && !menu.contains(e.target)) closeMenu();
	};
	const onWindowBlur = () => closeMenu();
	function openMenu(row, x, y) {
		closeMenu();
		const path = row._ent.path;
		menu = el("div", "slash-menu tree-menu");
		menu.setAttribute("role", "menu");
		menu.setAttribute("aria-label", "File");
		const item = el("button", "pal-item");
		item.type = "button";
		item.setAttribute("role", "menuitem");
		item.append(el("span", "label", "Open in Viewer"));
		item.addEventListener("click", () => {
			closeMenu({ restore: false });
			openProject(path);
		});
		menu.append(item);
		menu.addEventListener("keydown", (e) => {
			if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				closeMenu({ restore: true });
			} else if (e.key === "Tab") {
				e.preventDefault();
			}
		});
		document.body.append(menu);
		const r = menu.getBoundingClientRect();
		menu.style.left = `${Math.max(4, Math.min(x, innerWidth - r.width - 4))}px`;
		menu.style.top = `${Math.max(4, Math.min(y, innerHeight - r.height - 4))}px`;
		menuReturn = row;
		crust.browser.hide(true, "tree-menu"); // the menu can reach over the page view
		document.addEventListener("pointerdown", onOutside, true);
		window.addEventListener("blur", onWindowBlur);
		item.focus();
	}
	$("#tree").addEventListener("contextmenu", (e) => {
		const row = e.target.closest(".node");
		// Selftest only: the deliberate break "open-tree" offers the item for every file.
		const offer = (p) => VK.viewable(p) || info?.selftestViewerBreak === "open-tree";
		if (!row || !row._ent || row._ent.dir || !offer(row._ent.path)) return closeMenu(); // no item, no menu
		e.preventDefault();
		openMenu(row, e.clientX, e.clientY);
	});
	// A tree row is dragged by its project path (a drop on the Viewer opens it).
	$("#tree").addEventListener("dragstart", (e) => {
		const row = e.target.closest?.(".node");
		if (!row || !row._ent || row._ent.dir) return;
		e.dataTransfer.effectAllowed = "copy";
		e.dataTransfer.setData(TREE_TYPE, row._ent.path);
	});

	const edBtn = $("#editor-open-viewer");
	// Called by editor.js whenever the shown file changes: the button is there for a file the Viewer can show.
	function syncEditorButton(path) {
		const ok = !!path && VK.viewable(path);
		edBtn.hidden = !ok;
		edBtn.dataset.path = ok ? path : "";
	}
	edBtn.addEventListener("click", () => edBtn.dataset.path && openProject(edBtn.dataset.path));

	// --- drop -------------------------------------------------------------------------------------------------------------------
	const hint = $("#drop-hint");
	let hintOn = false;
	let heartbeat = 0;
	const ours = (e) => {
		const t = [...(e.dataTransfer?.types || [])];
		return t.includes("Files") || t.includes(TREE_TYPE);
	};
	function showHint() {
		if (hintOn) return;
		hintOn = true;
		hint.hidden = false;
		heartbeat = setTimeout(hideHint, 900); // dragover renews it; if none comes the drag is over
		crust.browser.hide(true, "drop"); // or the native page view would swallow the drop
	}
	function hideHint() {
		clearTimeout(heartbeat);
		if (!hintOn) return;
		hintOn = false;
		hint.hidden = true;
		hint.classList.remove("over");
		crust.browser.hide(false, "drop");
	}
	// A drag over the app while the Viewer tab is shown. dragover repeats while the pointer is over the window; when it stops (the pointer left
	// the window, or the drag ended elsewhere) the hint goes away.
	document.addEventListener(
		"dragenter",
		(e) => {
			if (ours(e) && activeTab === "browser") showHint();
		},
		true,
	);
	document.addEventListener(
		"dragover",
		(e) => {
			if (!hintOn) return;
			clearTimeout(heartbeat);
			heartbeat = setTimeout(hideHint, 900);
		},
		true,
	);
	for (const t of ["dragend", "drop"]) document.addEventListener(t, () => hintOn && setTimeout(hideHint, 0), true);
	hint.addEventListener("dragover", (e) => {
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
		hint.classList.add("over");
	});
	hint.addEventListener("dragleave", () => hint.classList.remove("over"));
	// The real path of a dropped File. A test run may carry the path on the File (a script cannot make the OS give a real path).
	const pathFor = (f) => (info?.selftest && f && f.testPath) || crust.browser.pathOf(f);
	async function dropped(dt) {
		const rel = dt.getData(TREE_TYPE);
		let arg = null;
		if (rel) arg = { rel };
		else {
			const f = dt.files && dt.files[0];
			const abs = f ? pathFor(f) : "";
			if (abs) arg = { abs };
		}
		if (!arg) return void toast("That path can't be shown here.", "warning");
		let r;
		try {
			r = await crust.browser.openFile(arg);
		} catch {
			r = null;
		}
		if (r && r.ok) switchTab("browser");
		else toast((r && r.message) || "That path can't be shown here.", "warning");
		return r;
	}
	hint.addEventListener("drop", (e) => {
		e.preventDefault();
		const dt = e.dataTransfer;
		const rel = dt.getData(TREE_TYPE);
		const files = [...(dt.files || [])];
		hideHint();
		// getData and files are only readable during the event: hand a snapshot on.
		dropped({ getData: (t) => (t === TREE_TYPE ? rel : ""), files });
	});
	// A switch of tab or a new page clears a refusal that belonged to the typed text.
	crust.browser.onState((s) => {
		if (s.activeId && s.activeId !== lastActive) clearRefusal();
		lastActive = s.activeId || lastActive;
	});
	let lastActive = null;

	// Test hooks (the selftest steps layers and viewer-open): a synthetic tree row put at the top of the tree, and the REAL right-click handler
	// run on it. Nothing else is faked: the menu, its item and the call into main are the product code.
	const testTree = {
		row: null,
		make(path) {
			this.remove();
			const row = el("div", "node");
			row.setAttribute("role", "treeitem");
			row.dataset.path = path;
			row.draggable = true;
			row._ent = { name: path.split("/").pop(), path, dir: false };
			row.append(el("span", "twisty", ""), el("span", "name", row._ent.name));
			$("#tree").prepend(row);
			$("#tree").scrollTop = 0;
			this.row = row;
			return row;
		},
		open(path = "docs/pricing.html") {
			const row = this.make(path);
			const r = row.getBoundingClientRect();
			row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + 24, clientY: r.top + r.height / 2 }));
			return row;
		},
		remove() {
			this.row?.remove();
			this.row = null;
		},
		close() {
			closeMenu();
			this.remove();
		},
	};

	window.viewerOpen = {
		testTree,
		testShow: show,
		display,
		go,
		refuse,
		clearRefusal,
		openProject,
		syncEditorButton,
		isOpen: () => isOpen,
		items: () => items.slice(),
		highlighted: () => hi,
		list: () => list,
		menu: () => menu,
		hintShown: () => hintOn,
		closeSuggestions: close,
		closeMenu,
		showHint,
		hideHint,
		dropped,
		TREE_TYPE,
	};
})();
