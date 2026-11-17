// @-mentions in the chat input: typing `@part` lists files and folders of the repo; accepting inserts `path`.
// Same look and keyboard handling as the slash menu (slash-menu.js); sources come from palette.js.
"use strict";

(() => {
	const MAX_VISIBLE = 12;
	const TRIGGER = /(^|\s)@([^\s@`]*)$/;
	const input = $("#input");
	const menu = el("div", "slash-menu mention-menu");
	menu.id = "mention-menu";
	menu.setAttribute("role", "listbox");
	menu.setAttribute("aria-label", "Files and folders");
	menu.hidden = true;
	$("#composer").append(menu);

	let open = false;
	let items = [];
	let active = 0;
	let blurTimer = 0;
	let dirsFor = null;
	let dirs = [];
	let refreshing = false;

	// Folders are derived from the file list (the index only has files).
	function folders() {
		if (dirsFor !== fileIndex) {
			const set = new Set();
			for (const f of fileIndex) {
				for (let i = f.indexOf("/"); i >= 0; i = f.indexOf("/", i + 1)) set.add(f.slice(0, i));
			}
			dirs = [...set];
			dirsFor = fileIndex;
		}
		return dirs;
	}

	// The `@query` right before the caret, or null.
	function context() {
		if (input.selectionStart !== input.selectionEnd) return null;
		const pos = input.selectionStart;
		const m = TRIGGER.exec(input.value.slice(0, pos));
		if (!m) return null;
		return { query: m[2], start: pos - m[2].length - 1, end: pos };
	}

	function match(query) {
		const all = [...folders().map((p) => ({ path: p, dir: true })), ...fileIndex.map((p) => ({ path: p, dir: false }))];
		if (!query) {
			// Top level first: folders, then root files.
			return all
				.filter((x) => !x.path.includes("/"))
				.sort((a, b) => Number(b.dir) - Number(a.dir) || a.path.localeCompare(b.path))
				.slice(0, MAX_VISIBLE)
				.map((x) => ({ ...x, hits: [] }));
		}
		const out = [];
		for (const x of all) {
			const base = x.path.slice(x.path.lastIndexOf("/") + 1);
			const mb = fuzzy(query, base);
			if (mb) out.push({ ...x, score: mb.score + 10, hits: mb.hits.map((h) => h + x.path.length - base.length) });
			else {
				const mp = fuzzy(query, x.path);
				if (mp) out.push({ ...x, score: mp.score, hits: mp.hits });
			}
		}
		out.sort((a, b) => b.score - a.score || a.path.length - b.path.length);
		return out.slice(0, MAX_VISIBLE);
	}

	const folderIcon = () => {
		const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
		s.setAttribute("viewBox", "0 0 16 16");
		s.setAttribute("aria-hidden", "true");
		s.classList.add("mention-icon");
		const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
		p.setAttribute("d", "M2 4.5A1 1 0 0 1 3 3.5h3l1.5 1.5H13a1 1 0 0 1 1 1V11.5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z");
		s.append(p);
		return s;
	};

	function draw() {
		const ctx = context();
		if (!ctx) return close();
		const prev = items[active]?.path;
		items = match(ctx.query);
		active = Math.max(0, items.findIndex((c) => c.path === prev));
		if (!items.length) return close();
		menu.replaceChildren(
			...items.map((c, i) => {
				const row = el("div", `pal-item${i === active ? " active" : ""}`);
				row.id = `mention-opt-${i}`;
				row.setAttribute("role", "option");
				row.setAttribute("aria-selected", String(i === active));
				if (c.dir) row.append(folderIcon());
				const label = highlight(c.path, c.hits);
				label.classList.add("slash-name");
				if (c.dir) label.append("/");
				row.append(label);
				row.onmousedown = (e) => e.preventDefault();
				row.onmousemove = () => setActive(i, false);
				row.onclick = () => accept(i);
				return row;
			}),
		);
		menu.hidden = false;
		if (prevControls === undefined) prevControls = input.getAttribute("aria-controls"); // what close() puts back
		input.setAttribute("aria-controls", "mention-menu");
		input.setAttribute("aria-expanded", "true");
		input.setAttribute("aria-autocomplete", "list");
		setActive(active);
	}

	function setActive(i, scroll = true) {
		const rows = menu.children;
		if (!rows.length) return;
		rows[active]?.classList.remove("active");
		rows[active]?.setAttribute("aria-selected", "false");
		active = (i + rows.length) % rows.length;
		rows[active].classList.add("active");
		rows[active].setAttribute("aria-selected", "true");
		input.setAttribute("aria-activedescendant", rows[active].id);
		if (scroll) rows[active].scrollIntoView({ block: "nearest" });
	}

	let prevControls; // undefined: the menu isn't holding aria-controls
	function close() {
		if (!open && menu.hidden) return;
		open = false;
		menu.hidden = true;
		menu.replaceChildren();
		items = [];
		input.setAttribute("aria-expanded", "false");
		if (prevControls === null) input.removeAttribute("aria-controls");
		else if (prevControls !== undefined) input.setAttribute("aria-controls", prevControls);
		prevControls = undefined;
		input.removeAttribute("aria-activedescendant");
	}

	async function refresh() {
		if (refreshing || Date.now() - fileIndexAt < 30_000) return;
		refreshing = true;
		try {
			fileIndex = await crust.fs.index();
			fileIndexAt = Date.now();
		} catch {}
		refreshing = false;
		if (open) draw();
	}

	function update() {
		if (!context()) return close();
		open = true;
		draw();
		if (!open) open = !!context(); // no matches yet: stay armed so a refreshed index can fill it
		refresh();
	}

	function accept(i) {
		const c = items[i];
		const ctx = context();
		if (!c || !ctx) return close();
		close();
		const text = `\`${c.path}${c.dir ? "/" : ""}\` `;
		input.value = input.value.slice(0, ctx.start) + text + input.value.slice(ctx.end);
		const caret = ctx.start + text.length;
		input.focus();
		input.setSelectionRange(caret, caret);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	}

	input.addEventListener("input", update);
	input.addEventListener("click", update);
	input.addEventListener("focus", () => clearTimeout(blurTimer));
	input.addEventListener("blur", () => {
		blurTimer = setTimeout(close, 150);
	});

	// Capture phase so this runs before the composer's own Enter/Arrow/Escape handling.
	input.addEventListener(
		"keydown",
		(e) => {
			if (menu.hidden || e.isComposing) return;
			const k = e.key;
			if (k === "ArrowDown") setActive(active + 1);
			else if (k === "ArrowUp") setActive(active - 1);
			else if ((k === "Tab" && !e.shiftKey) || (k === "Enter" && !e.shiftKey)) accept(active);
			else if (k === "Escape") close();
			else return;
			e.preventDefault();
			e.stopImmediatePropagation();
		},
		true,
	);

	selftestSteps.push(async ({ snap, wait }) => {
		switchTab("browser");
		input.focus();
		input.value = "Look at @pack";
		input.setSelectionRange(input.value.length, input.value.length);
		input.dispatchEvent(new Event("input", { bubbles: true }));
		await wait(500);
		const rows = [...menu.querySelectorAll(".pal-item")].map((r) => r.textContent);
		console.error(`SELFTEST mention: "@pack" -> ${rows.length} rows (${rows[0] || ""}) -> ${rows.length ? "OK" : "MISMATCH"}`);
		await snap("mention");
		accept(0);
		console.error(`SELFTEST mention accept: ${JSON.stringify(input.value)} -> ${/^Look at `[^`]+` $/.test(input.value) ? "OK" : "MISMATCH"}`);
		input.value = "";
		close();
	});
})();
