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
		const out = listedAgentCommands().map((c) => ({
			name: c.name,
			args: "",
			description: c.description || "",
			source: c.source || "command",
			builtin: false,
		}));
		for (const c of listedBuiltinCommands()) {
			if (isShadowed(c.name)) continue;
			out.push({ name: c.name, args: c.args || "", description: c.description, source: "crust", builtin: true, disabledWhy: window.agentUi?.slashReason(c.name) || "" });
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
		if (!items.length) return close();
		// The highlight goes to the same command as before when it is still available, else to the first available one (none when all are disabled).
		const prevAt = items.findIndex((c) => c.name === prev && !c.disabledWhy);
		active = prevAt >= 0 ? prevAt : items.findIndex((c) => !c.disabledWhy);
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
				if (c.disabledWhy) {
					// This chat's agent cannot do it: the row stays listed, disabled, with the reason in place of the description.
					row.classList.add("is-disabled");
					row.setAttribute("aria-disabled", "true");
					row.title = c.disabledWhy;
					row.dataset.reason = c.disabledWhy; // the reason line under the chat shows it while the row is hovered
					row.append(el("span", "desc", c.disabledWhy));
				} else if (c.description) row.append(el("span", "desc", c.description));
				row.append(el("span", "kind slash-badge", c.source));
				row.onmousedown = (e) => e.preventDefault(); // keep focus in the input
				row.onmousemove = () => !c.disabledWhy && setActive(i, false);
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
		if (i < 0) {
			active = -1; // every row is disabled: nothing is highlighted
			input.removeAttribute("aria-activedescendant");
			return;
		}
		active = (i + rows.length) % rows.length;
		rows[active].classList.add("active");
		rows[active].setAttribute("aria-selected", "true");
		input.setAttribute("aria-activedescendant", rows[active].id);
		if (scroll) rows[active].scrollIntoView({ block: "nearest" });
	}
	// The arrow keys go to the next available row in that direction (wrapping); disabled rows are skipped.
	function step(dir) {
		const n = items.length;
		for (let k = 1; k <= n; k++) {
			const j = (((active < 0 ? (dir > 0 ? -1 : 0) : active) + dir * k) % n + n) % n;
			if (!items[j].disabledWhy) return setActive(j);
		}
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
		if (c.disabledWhy) return toast(c.disabledWhy, "warning"); // the menu stays open; the reason is on the row too
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
			if (k === "ArrowDown") step(1);
			else if (k === "ArrowUp") step(-1);
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
