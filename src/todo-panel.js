// Todo panel above the composer: shows the chat's todo list as Pi's todo tool updates it.
// Fed by the hook bus: tool:end (live and history) -> chat.todos; chat:cleared resets; chat:activated redraws.
"use strict";

(() => {
	const panel = $("#todo-panel");
	const SVG = "http://www.w3.org/2000/svg";
	const ICONS = {
		chevron: ["M4.5 6.5L8 10l3.5-3.5"],
		done: ["M4.5 8.5l2.5 2.5 4.5-5"],
		todo: [],
		doing: [],
	};
	let collapseTimer = 0;

	function icon(kind) {
		const s = document.createElementNS(SVG, "svg");
		s.setAttribute("viewBox", "0 0 16 16");
		s.setAttribute("aria-hidden", "true");
		s.setAttribute("fill", "none");
		s.setAttribute("stroke", "currentColor");
		s.setAttribute("stroke-width", "1.4");
		s.setAttribute("stroke-linecap", "round");
		s.setAttribute("stroke-linejoin", "round");
		if (kind !== "chevron") {
			const c = document.createElementNS(SVG, "circle");
			c.setAttribute("cx", "8");
			c.setAttribute("cy", "8");
			c.setAttribute("r", "5.5");
			s.append(c);
			if (kind === "doing") {
				const h = document.createElementNS(SVG, "path");
				h.setAttribute("d", "M8 4.5a3.5 3.5 0 0 1 0 7z");
				h.setAttribute("fill", "currentColor");
				h.setAttribute("stroke", "none");
				s.append(h);
			}
		}
		for (const d of ICONS[kind] || []) {
			const p = document.createElementNS(SVG, "path");
			p.setAttribute("d", d);
			s.append(p);
		}
		return s;
	}

	// Generic todo item: text|content|title, done flag or status.
	function normalise(raw) {
		if (!Array.isArray(raw)) return null;
		return raw
			.map((t) => {
				if (typeof t === "string") return { text: t, state: "todo" };
				const text = String(t?.text ?? t?.content ?? t?.title ?? t?.description ?? "").trim();
				const status = String(t?.status ?? "").toLowerCase().replace(/[\s-]/g, "_");
				const state = t?.done === true || status === "done" || status === "completed" ? "done" : status === "in_progress" || status === "doing" ? "doing" : "todo";
				return { text, state };
			})
			.filter((t) => t.text);
	}

	function render() {
		clearTimeout(collapseTimer);
		const c = active;
		const todos = c?.todos;
		if (!todos?.length) {
			panel.hidden = true;
			panel.replaceChildren();
			return;
		}
		const done = todos.filter((t) => t.state === "done").length;
		const collapsed = !!c.todosCollapsed;
		const head = el("button", "todo-head");
		head.type = "button";
		head.setAttribute("aria-expanded", String(!collapsed));
		head.setAttribute("aria-controls", "todo-list");
		head.append(icon("chevron"), el("span", "todo-title", "Todos"), el("span", "todo-count", `${done}/${todos.length}`));
		head.onclick = () => {
			c.todosCollapsed = !c.todosCollapsed;
			render();
		};
		panel.classList.toggle("collapsed", collapsed);
		panel.replaceChildren(head);
		const list = el("ul", "todo-list");
		list.id = "todo-list";
		list.hidden = collapsed;
		for (const t of todos) {
			const li = el("li", `todo-item ${t.state}`);
			li.append(icon(t.state === "done" ? "done" : t.state), el("span", "todo-text", t.text));
			li.firstChild.classList.add("todo-icon");
			list.append(li);
		}
		panel.append(list);
		panel.hidden = false;
		if (done === todos.length && !collapsed) {
			collapseTimer = setTimeout(() => {
				if (active === c && c.todos === todos) {
					c.todosCollapsed = true;
					render();
				}
			}, 3000);
		}
	}

	onCrust("tool:end", (chat, ev) => {
		if (ev.isError) return;
		// Pi's todo tools, or any tool whose result carries a todo list
		if (!/^todo(_write|_read)?$/i.test(ev.toolName || "") && !Array.isArray(ev.result?.details?.todos)) return;
		const todos = normalise(ev.result?.details?.todos ?? ev.args?.todos);
		if (!todos) return;
		const wasDone = chat.todos?.length && chat.todos.every((t) => t.state === "done");
		chat.todos = todos;
		if (!ev.history && wasDone) chat.todosCollapsed = false;
		if (chat === active) render();
	});
	onCrust("chat:cleared", (chat) => {
		chat.todos = [];
		chat.todosCollapsed = false;
		if (chat === active) render();
	});
	onCrust("chat:activated", render);


	selftestSteps.push(async ({ snap, wait }) => {
		const c = active;
		const fake = { toolName: "todo", args: {}, isError: false, history: false, result: { details: { todos: [{ id: 1, text: "Read the plan", done: true }, { id: 2, text: "Build the mention menu", done: true }, { id: 3, text: "Add the todo panel", done: false, status: "in_progress" }, { id: 4, text: "Render Mermaid diagrams", done: false }] } } };
		emitCrust("tool:end", c, fake);
		await wait(400);
		console.error(`SELFTEST todo: panel ${panel.hidden ? "hidden" : panel.querySelector(".todo-count").textContent} -> ${!panel.hidden && panel.querySelectorAll(".todo-item").length === 4 ? "OK" : "MISMATCH"}`);
		await snap("todo");
		const was = themeSetting();
		setTheme(currentTheme() === "dark" ? "light" : "dark");
		await wait(500);
		await snap(`todo-${currentTheme()}`);
		setTheme(was);
		await wait(400);
		emitCrust("chat:cleared", c);
	});
})();
