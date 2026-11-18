// Design tab: the Figma connection pill (header) and its inline setup panel. Words come from figma-status.js (main process),
// arriving with the result of crust.figma.status() / test(). Checks run when the Design tab opens, when the panel opens, on
// "Test connection" and after a Figma action fails (window.crustFigma.recheck). Never on a timer, never a toast.
// Steps checked against Figma's developer docs on 2026-11-18; real Figma desktop still has to confirm them (verify).
"use strict";

(() => {
	const pill = $("#figma-pill");
	const panel = $("#figma-panel");
	const live = $("#figma-live");
	if (!pill || !panel) return;

	const STEPS = [
		{ id: 1, text: "Install Figma desktop and sign in (figma.com/downloads)." },
		{ id: 2, text: "Open a design file in Figma desktop." },
		{ id: 3, text: "Switch to Dev Mode: the toggle at the top of the toolbar, or press Shift+D." },
		{ id: 4, text: "In the right sidebar, find MCP server and click Enable desktop MCP server." },
		{ id: 5, text: "No MCP server option in Dev Mode? Your seat or plan may not allow it. Ask the Figma admin for a Dev or Full seat." },
		{ id: 6, text: "Select a frame, then choose Test connection." },
	];

	let res = null; // last status or test result
	let checks = null; // [{ label, ok }] from the last Test connection
	let busy = false; // a check is running
	let editing = false; // file link input shown
	let fileError = "";
	let seq = 0;
	let announced = "";

	const age = () => {
		if (!res) return "Not checked yet";
		const s = Math.round((Date.now() - res.checkedAt) / 1000);
		return s < 10 ? "Checked just now" : s < 60 ? `Checked ${s} s ago` : `Checked ${Math.round(s / 60)} min ago`;
	};

	// Which steps are still open for a result, and which one is first. Steps 1 to 5 can only be proven by the port answering
	// (Figma runs, the server is on); step 2 by a design file being open; step 6 by a successful read of the selection.
	function openSteps(r) {
		if (!r) return [];
		const reached = ["no_file", "wrong_tab", "no_selection", "ready"].includes(r.state);
		if (r.state === "not_reachable") {
			const first = { not_installed: 1, not_running: 1, server_off: 3, seat: 5, unknown: 1 }[r.hint] || 1;
			return STEPS.slice(0, 5).map((s) => ({ ...s, first: s.id === first }));
		}
		if (reached) {
			const open = [];
			if (r.state === "no_file" || r.state === "wrong_tab") open.push(STEPS[1]);
			if (r.state === "no_selection") open.push(STEPS[5]);
			return open.map((s, i) => ({ ...s, first: i === 0 }));
		}
		return [];
	}

	function paintPill() {
		const text = busy || !res ? "Figma: checking…" : res.pill;
		pill.textContent = text;
		pill.classList.toggle("on", !busy && res?.state === "ready");
		pill.title = `${age()}. Click for Figma setup.`;
		const say = busy ? "" : text;
		if (say && say !== announced) {
			announced = say;
			live.textContent = say;
		}
	}

	function stateLine() {
		if (busy) return "Looking for Figma desktop.";
		return res?.message || "";
	}

	function renderFile(box) {
		const f = res?.fileLink;
		box.replaceChildren(el("div", "fp-label", "Figma file link (only for the Figma picker)"));
		if (f?.set && !editing) {
			const row = el("div", "fp-row");
			const change = el("button", "fp-link", "Change");
			change.type = "button";
			change.onclick = () => {
				editing = true;
				fileError = "";
				render();
				panel.querySelector(".fp-file input")?.focus();
			};
			row.append(el("span", "", `File: ${f.name || "(unnamed)"}`), change);
			box.append(row);
		} else {
			const row = el("div", "fp-row");
			const input = el("input");
			input.type = "text";
			input.placeholder = "https://www.figma.com/design/…";
			input.setAttribute("aria-label", "Figma file link");
			input.spellcheck = false;
			const save = el("button", "btn secondary", "Save");
			save.type = "button";
			const doSave = async () => {
				const r = await crust.figma.setFile(input.value);
				if (!r.ok) {
					fileError = r.error;
					return render();
				}
				fileError = "";
				editing = false;
				res = { ...res, fileLink: r.fileLink };
				render();
			};
			save.onclick = doSave;
			input.onkeydown = (e) => e.key === "Enter" && doSave();
			row.append(input, save);
			box.append(row);
			if (fileError) box.append(el("div", "fp-hint", fileError));
		}
		box.append(el("div", "fp-hint", "Compare and Tokens don't need this."));
	}

	function render() {
		paintPill();
		if (panel.hidden) return;
		const kids = [el("div", "fp-title", "Figma connection")];
		const line = el("p", "fp-line", stateLine());
		line.setAttribute("aria-live", "polite");
		kids.push(line);
		if (!busy && res?.state === "problem") {
			const copy = el("button", "btn secondary", "Copy");
			copy.type = "button";
			copy.onclick = () => navigator.clipboard?.writeText(res.message).catch(() => {});
			const row = el("div", "fp-row");
			row.append(copy);
			kids.push(row);
		}
		const steps = busy ? [] : openSteps(res);
		if (steps.length) {
			const ol = el("ol", "fp-steps");
			for (const s of steps) {
				const li = el("li", s.first ? "first" : "", s.text);
				li.dataset.n = s.id;
				if (s.first) li.setAttribute("aria-current", "step");
				ol.append(li);
			}
			kids.push(ol);
		}
		const test = el("button", "btn secondary", busy ? "Checking…" : "Test connection");
		test.type = "button";
		test.disabled = busy;
		if (busy) test.setAttribute("aria-busy", "true");
		test.onclick = runTest;
		const row = el("div", "fp-row");
		const help = el("button", "fp-link", "Figma's own steps");
		help.type = "button";
		help.onclick = () => crust.figma.openHelp();
		row.append(test, help, el("span", "fp-age", age()));
		kids.push(row);
		if (checks && !busy) {
			const ul = el("ul", "fp-checks");
			ul.setAttribute("aria-label", "What was checked");
			for (const c of checks) {
				const li = el("li", c.ok ? "ok" : "");
				li.append(el("span", "mark", c.ok ? "✓" : "–"), el("span", "", c.label));
				ul.append(li);
			}
			kids.push(el("div", "fp-hint", "Checked:"), ul);
		}
		const file = el("div", "fp-file");
		renderFile(file);
		kids.push(file);
		panel.replaceChildren(...kids);
	}

	async function check(fn, keepChecks) {
		const mine = ++seq;
		busy = true;
		if (!keepChecks) checks = null;
		render();
		let r = null;
		try {
			r = await fn();
		} catch (e) {
			r = { state: "problem", hint: null, message: String(e.message || e), pill: "Figma: problem", fileLink: res?.fileLink, checkedAt: Date.now() };
		}
		if (mine !== seq) return;
		busy = false;
		res = r;
		if (r.checks) checks = r.checks;
		render();
	}

	const refresh = () => check(() => crust.figma.status());
	const runTest = () => check(() => crust.figma.test(), true);

	function open() {
		panel.hidden = false;
		pill.setAttribute("aria-expanded", "true");
		render();
		refresh();
	}
	function close(focus) {
		panel.hidden = true;
		pill.setAttribute("aria-expanded", "false");
		if (focus) pill.focus();
	}

	pill.onclick = () => (panel.hidden ? open() : close());
	pill.addEventListener("mouseenter", () => (pill.title = `${age()}. Click for Figma setup.`));
	document.addEventListener("keydown", (e) => {
		if (e.key === "Escape" && !panel.hidden && !e.defaultPrevented) {
			e.preventDefault();
			close(true);
		}
	});
	onCrust("tab:changed", (name) => {
		if (name === "design") refresh();
	});

	window.crustFigma = { recheck: refresh, openPanel: () => (panel.hidden ? open() : refresh()), state: () => ({ res, busy, open: !panel.hidden }) };
	paintPill();
})();
