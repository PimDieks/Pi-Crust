// Inline slash-command autocomplete for the chat input: typing `/name` (no space yet) lists matching commands.
"use strict";

(() => {
	const MAX_VISIBLE = 12;
	const input = $("#input");
	const menu = el("div", "slash-menu");
	menu.id = "slash-menu";
	menu.setAttribute("role", "listbox");
	menu.setAttribute("aria-label", "Slash commands");
	menu.hidden = true;
	$("#composer").append(menu);
	input.setAttribute("aria-controls", "slash-menu");
	input.setAttribute("aria-expanded", "false");
	input.setAttribute("aria-autocomplete", "list");

	let open = false;
	let items = [];
	let active = 0;
	let blurTimer = 0;

	function allCommands() {
		const out = commandList.map((c) => ({
			name: c.name,
			args: "",
			description: c.description || "",
			source: c.source || "command",
			builtin: false,
		}));
		for (const c of allBuiltinCommands()) {
			if (isShadowed(c.name)) continue;
			out.push({ name: c.name, args: c.args || "", description: c.description, source: "crust", builtin: true });
		}
		return out;
	}

	function match(query) {
		const q = query.toLowerCase();
		const all = allCommands();
		if (!q) return all.sort((a, b) => a.name.localeCompare(b.name)).map((c) => ({ ...c, hits: [] }));
		const prefix = [];
		const fuzzed = [];
		for (const c of all) {
			if (c.name.toLowerCase().startsWith(q)) prefix.push({ ...c, hits: [...q].map((_, i) => i) });
			else {
				const m = fuzzy(q, c.name);
				if (m) fuzzed.push({ ...c, hits: m.hits, score: m.score });
			}
		}
		prefix.sort((a, b) => a.name.length - b.name.length || a.name.localeCompare(b.name));
		fuzzed.sort((a, b) => b.score - a.score);
		return [...prefix, ...fuzzed];
	}

	function draw() {
		const q = input.value.slice(1);
		const prev = items[active]?.name;
		items = match(q);
		active = Math.max(0, items.findIndex((c) => c.name === prev));
		if (!items.length) return close();
		menu.replaceChildren(
			...items.map((c, i) => {
				const row = el("div", `pal-item${i === active ? " active" : ""}`);
				row.id = `slash-opt-${i}`;
				row.setAttribute("role", "option");
				row.setAttribute("aria-selected", String(i === active));
				const label = highlight(c.name, c.hits);
				label.prepend("/");
				label.classList.add("slash-name");
				row.append(label);
				if (c.args) row.append(el("span", "slash-args", c.args));
				if (c.description) row.append(el("span", "desc", c.description));
				row.append(el("span", "kind slash-badge", c.source));
				row.onmousedown = (e) => e.preventDefault(); // keep focus in the input
				row.onmousemove = () => setActive(i, false);
				row.onclick = () => accept(i, false);
				return row;
			}),
		);
		menu.hidden = false;
		input.setAttribute("aria-expanded", "true");
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

	function close() {
		open = false;
		menu.hidden = true;
		menu.replaceChildren();
		items = [];
		input.setAttribute("aria-expanded", "false");
		input.removeAttribute("aria-activedescendant");
	}

	function update() {
		if (!/^\/\S*$/.test(input.value)) return close();
		if (!open) {
			open = true;
			draw();
			if (state.ready) {
				// Refresh once per opening; keep using the cache if it fails.
				rpc("get_commands")
					.then((r) => {
						if (r.success) commandList = r.data?.commands || [];
						if (open && /^\/\S*$/.test(input.value)) draw();
					})
					.catch(() => {});
			}
		} else draw();
	}

	function accept(i, send) {
		const c = items[i];
		if (!c) return;
		close();
		input.value = `/${c.name} `;
		input.focus();
		input.setSelectionRange(input.value.length, input.value.length);
		if (send && c.builtin && !c.args) submit();
	}

	input.addEventListener("input", update);
	input.addEventListener("focus", () => clearTimeout(blurTimer));
	input.addEventListener("blur", () => {
		blurTimer = setTimeout(close, 150);
	});

	// Capture phase so this runs before the composer's own Enter/Arrow/Escape handling.
	input.addEventListener(
		"keydown",
		(e) => {
			if (!open || e.isComposing) return;
			const k = e.key;
			if (k === "ArrowDown") setActive(active + 1);
			else if (k === "ArrowUp") setActive(active - 1);
			else if (k === "Tab" && !e.shiftKey) accept(active, false);
			else if (k === "Enter" && !e.shiftKey) accept(active, true);
			else if (k === "Escape") close();
			else return;
			e.preventDefault();
			e.stopImmediatePropagation();
		},
		true,
	);
})();
