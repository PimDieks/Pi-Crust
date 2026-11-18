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
		{ id: 1, text: "Install Figma desktop and sign in." },
		{ id: 2, text: "Open a design file in Figma desktop." },
		{ id: 3, text: "Switch to Dev Mode: the toggle at the top of the toolbar, or press Shift+D." },
		{ id: 4, text: "In the right sidebar, find MCP server and click Enable desktop MCP server." },
		{ id: 5, text: "Select a frame, then choose Test connection." },
	];
	// Unnumbered note under step 4. The highlighted line when Figma answers with a refusal (seat).
	const SEAT_NOTE = "No MCP server option in Dev Mode? Your seat or plan may not allow it. Ask the Figma admin for a Dev or Full seat.";

	let res = null; // last status or test result
	let checks = null; // [{ label, ok }] from the last Test connection
	let busy = false; // a check is running
	let editing = false; // file link input shown
	let fileError = "";
	let draft = ""; // half-typed file link, survives every redraw
	let seq = 0;
	let announced = "";

	const age = () => {
		if (!res) return "Not checked yet";
		const s = Math.round((Date.now() - res.checkedAt) / 1000);
		return s < 10 ? "Checked just now" : s < 60 ? `Checked ${s} s ago` : `Checked ${Math.round(s / 60)} min ago`;
	};

	// What the app can prove, per step. Figma running: step 1 (hint server_off or seat, or any answer). The server answering
	// (anything but not_reachable, and not "problem", which may be some other program on the port): steps 1, 3 and 4. A design
	// file open (no_selection, ready): step 2. A selection read (ready): step 5. Nothing else is ticked.
	function stepsFor(r) {
		if (!r || r.state === "problem") return null;
		const done = new Set();
		if (r.state === "not_reachable") {
			if (r.hint === "server_off" || r.hint === "seat") done.add(1);
		} else {
			[1, 3, 4].forEach((n) => done.add(n));
			if (r.state === "no_selection" || r.state === "ready") done.add(2);
			if (r.state === "ready") done.add(5);
		}
		const firstOpen = STEPS.find((s) => !done.has(s.id))?.id;
		const seat = r.state === "not_reachable" && r.hint === "seat";
		return { steps: STEPS.map((s) => ({ ...s, done: done.has(s.id), first: !seat && s.id === firstOpen })), seat };
	}

	function paintPill() {
		const text = busy || !res ? "Figma: checking…" : res.pill;
		pill.textContent = text;
		pill.classList.toggle("on", !busy && res?.state === "ready");
		pill.title = `${text}. ${age()}`; // the full state, so a truncated pill is still readable
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
			change.dataset.k = "file-change";
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
			input.dataset.k = "file-input";
			input.value = draft;
			input.oninput = () => (draft = input.value);
			const save = el("button", "btn secondary", "Save");
			save.type = "button";
			save.dataset.k = "file-save";
			const doSave = async () => {
				const r = await crust.figma.setFile(input.value);
				if (!r.ok) {
					fileError = r.error;
					return render();
				}
				fileError = "";
				editing = false;
				draft = "";
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

	// Redraw the panel, keeping what the user is doing: the focused control, and the caret and text of the file link.
	function render() {
		paintPill();
		if (panel.hidden) return;
		const a = document.activeElement;
		const keep = a && panel.contains(a) && a.dataset.k ? { k: a.dataset.k, s: a.selectionStart, e: a.selectionEnd } : null;
		draw();
		if (keep) {
			const n = panel.querySelector(`[data-k="${keep.k}"]`);
			if (n) {
				n.focus({ preventScroll: true });
				if (keep.s != null && n.setSelectionRange) n.setSelectionRange(keep.s, keep.e);
			}
		}
	}

	function draw() {
		panel.classList.toggle("busy", busy);
		panel.setAttribute("aria-busy", busy ? "true" : "false");
		const kids = [el("div", "fp-title", "Figma connection")];
		const line = el("p", "fp-line", stateLine());
		line.setAttribute("aria-live", "polite");
		kids.push(line);
		if (res?.state === "problem") {
			const copy = el("button", "btn secondary", "Copy");
			copy.type = "button";
			copy.dataset.k = "copy";
			copy.onclick = () => navigator.clipboard?.writeText(res.message).catch(() => {});
			const row = el("div", "fp-row");
			row.append(copy);
			kids.push(row);
		}
		const plan = stepsFor(res); // while a check runs the last known steps stay, dimmed
		if (plan) {
			const wrap = el("div", "fp-steps-wrap");
			const list = (items) => {
				const ol = el("ol", "fp-steps");
				for (const s of items) {
					const li = el("li", [s.done ? "done" : "", s.first ? "first" : ""].join(" ").trim());
					li.dataset.n = s.id;
					if (s.done) li.append(el("span", "fp-sr", "Done: "));
					li.append(el("span", "", s.text));
					if (s.first) li.setAttribute("aria-current", "step");
					ol.append(li);
				}
				if (items[0].id > 1) ol.start = items[0].id;
				return ol;
			};
			const note = el("p", plan.seat ? "fp-note first" : "fp-note", SEAT_NOTE);
			if (plan.seat) note.setAttribute("aria-current", "true");
			wrap.append(list(plan.steps.slice(0, 4)), note, list(plan.steps.slice(4)));
			kids.push(wrap);
		}
		const test = el("button", "btn secondary", busy ? "Checking…" : "Test connection");
		test.type = "button";
		test.dataset.k = "test";
		if (busy) test.setAttribute("aria-disabled", "true"); // not disabled: keyboard focus stays on it
		test.onclick = () => !busy && runTest();
		const row = el("div", "fp-row");
		const help = el("button", "fp-link", "Figma's own steps");
		help.type = "button";
		help.dataset.k = "help";
		help.onclick = () => crust.figma.openHelp();
		row.append(test, help, el("span", "fp-age", age()));
		kids.push(row);
		if (checks) {
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
	document.addEventListener("keydown", (e) => {
		if (e.key !== "Escape" || panel.hidden || e.defaultPrevented) return;
		const a = document.activeElement;
		if (a !== pill && !panel.contains(a)) return; // focus is elsewhere: Escape belongs to whatever has it
		e.preventDefault();
		close(true);
	});
	onCrust("tab:changed", (name) => {
		if (name === "design") refresh();
	});
	// Another project: its own file link, so drop the old project's state and ask again.
	const projectChanged = () => {
		editing = false;
		fileError = "";
		draft = "";
		checks = null;
		res = null;
		refresh();
	};
	crust.repos.onChanged(projectChanged);

	// --- selftest: every state, driven by the stub Figma server that runs inside the app (needs PI_CRUST_SELFTEST=1 and
	// PI_CRUST_FIGMA_STUB=<port> with PI_CRUST_FIGMA_MCP_URL pointing at it; `npm run selftest -- figma-panel` with both set). ---
	selftestSteps.push(async ({ snap, wait }) => {
		if (!crust.figma.stubMode) return console.error("SELFTEST figma status: no stub hook -> MISMATCH");
		const text = (s) => panel.querySelector(s)?.textContent || "";
		const theme0 = themeSetting();
		const until = async (fn, ms = 4000) => {
			for (let t = 0; t < ms && !fn(); t += 50) await wait(50);
		};
		const idle = () => !window.crustFigma.state().busy;
		const cases = [
			// [name, stub mode, stub options, expected pill, expected panel text]
			["checking", "ready", { delayMs: 1500 }, "Figma: checking…", "Looking for Figma desktop."],
			["not-installed", "closed", { proc: { running: false, installed: false } }, "Figma: not connected", "doesn't seem to be installed", ["", "1"]],
			["not-running", "closed", { proc: { running: false, installed: true } }, "Figma: not connected", "isn't running", ["", "1"]],
			["server-off", "closed", { proc: { running: true } }, "Figma: not connected", "MCP server is off", ["1", "2"]],
			["unknown", "closed", { proc: {} }, "Figma: not connected", "switch on its MCP server", ["", "1"]],
			["seat", "http-403", {}, "Figma: not connected", "Dev or Full seat", ["1", "note"]],
			["no-file", "no-file", {}, "Figma: open a file", "no design file is open", ["1,3,4", "2"]],
			["wrong-tab", "wrong-tab", {}, "Figma: switch tab", "not a design file", ["1,3,4", "2"]],
			["no-selection", "no-selection", {}, "Figma: select a frame", "Select a frame in Figma desktop", ["1,2,3,4", "5"]],
			["ready", "ready", {}, "Figma: ready", "Selected frame: Stub Card", ["1,2,3,4,5", ""]],
			["problem", "not-mcp", {}, "Figma: problem", "Something else answers"],
		];
		switchTab("design");
		await wait(400);
		await crust.figma.stubMode("closed", { clearFile: true });
		window.crustFigma.openPanel();
		await until(idle);
		const shots = async (name) => {
			for (const th of ["dark", "light"]) {
				setTheme(th);
				await wait(900);
				await snap(`figma-panel-${name}-${th}`);
			}
		};
		for (const [name, mode, opts, pillWant, lineWant, doneWant] of cases) {
			await crust.figma.stubMode(mode, opts);
			window.crustFigma.recheck();
			await wait(name === "checking" ? 400 : 0);
			if (name !== "checking") await until(idle);
			const pillGot = pill.textContent;
			const got = text(".fp-line");
			const ok = pillGot === pillWant && got.includes(lineWant) && (pill.classList.contains("on") === (name === "ready"));
			console.error(`SELFTEST figma status ${name}: "${pillGot}" / "${got}" -> ${ok ? "OK" : "MISMATCH"}`);
			if (doneWant) {
				// ticks: which of the five steps are done, which is highlighted, five numbered steps, the seat note unnumbered
				const lis = [...panel.querySelectorAll(".fp-steps li")];
				const doneGot = lis.filter((li) => li.classList.contains("done")).map((li) => li.dataset.n).join(",");
				const firstGot = lis.filter((li) => li.classList.contains("first")).map((li) => li.dataset.n).join(",") || (panel.querySelector(".fp-note.first") ? "note" : "");
				const noteOk = panel.querySelectorAll(".fp-note").length === 1 && /^No MCP server option in Dev Mode\?/.test(text(".fp-note")) && !panel.querySelector(".fp-steps li:nth-child(6)");
				const srOk = lis.every((li) => li.classList.contains("done") === !!li.querySelector(".fp-sr"));
				const tickOk = lis.every((li) => !li.classList.contains("done") || getComputedStyle(li, "::before").content.includes("✓"));
				const good = lis.length === 5 && doneGot === doneWant[0] && firstGot === doneWant[1] && noteOk && srOk && tickOk;
				console.error(`SELFTEST figma steps ${name}: done=[${doneGot}] first=[${firstGot}] n=${lis.length} -> ${good ? "OK" : "MISMATCH"}`);
			}
			await shots(name);
			if (name === "checking") await until(idle);
			if (name === "no-selection") {
				// chat pane and window narrow: the same panel in a 340px wide Design pane
				const pane = document.querySelector('.tab-panel[data-panel="design"]');
				pane.style.cssText += ";max-width:340px";
				await shots("narrow");
				pane.style.maxWidth = "";
			}
		}
		// Test connection: ready (all ticks) and no selection (last tick is a dash)
		for (const [mode, want] of [["ready", "✓server answers✓design tools found✓selection read"], ["no-selection", "✓server answers✓design tools found–selection read"]]) {
			await crust.figma.stubMode(mode, {});
			[...panel.querySelectorAll("button")].find((b) => b.textContent === "Test connection").click();
			await until(() => !idle() || panel.querySelector(".fp-checks"), 500);
			await until(idle);
			const got = [...panel.querySelectorAll(".fp-checks li")].map((li) => li.textContent).join("");
			console.error(`SELFTEST figma test ${mode}: "${got}" -> ${got === want ? "OK" : "MISMATCH"}`);
			await shots(`test-${mode}`);
		}
		// file link row: empty, then saved ("File: <name>" + Change), then a bad link
		const unset = !!panel.querySelector(".fp-file input") && text(".fp-file").includes("Figma file link (only for the Figma picker)") && text(".fp-file").includes("Compare and Tokens don't need this.");
		console.error(`SELFTEST figma file link unset: placeholder="${panel.querySelector(".fp-file input")?.placeholder}" -> ${unset && panel.querySelector(".fp-file input").placeholder === "https://www.figma.com/design/…" ? "OK" : "MISMATCH"}`);
		await shots("file-unset");
		// a redraw (a check running) keeps the half-typed link, its caret, keyboard focus and the steps on screen
		{
			const inp = panel.querySelector(".fp-file input");
			inp.value = "https://www.fig";
			inp.dispatchEvent(new Event("input"));
			inp.focus();
			inp.setSelectionRange(5, 9);
			await crust.figma.stubMode("no-selection", { delayMs: 700 });
			window.crustFigma.recheck();
			await wait(200);
			const same = () => {
				const i = panel.querySelector(".fp-file input");
				return `value=${i.value === "https://www.fig"} focus=${document.activeElement === i} caret=${i.selectionStart}-${i.selectionEnd}`;
			};
			const during = `busy=${window.crustFigma.state().busy} ${same()} steps=${panel.querySelectorAll(".fp-steps li").length} aria-busy=${panel.getAttribute("aria-busy")}`;
			await shots("busy-link");
			await until(idle);
			const after = same();
			const good = during === "busy=true value=true focus=true caret=5-9 steps=5 aria-busy=true" && after === "value=true focus=true caret=5-9";
			console.error(`SELFTEST figma redraw keeps input: during [${during}] after [${after}] -> ${good ? "OK" : "MISMATCH"}`);
			const tb = [...panel.querySelectorAll("button")].find((b) => b.textContent === "Test connection");
			tb.focus();
			window.crustFigma.recheck();
			await wait(200);
			const k1 = document.activeElement?.dataset?.k;
			await until(idle);
			const k2 = document.activeElement?.dataset?.k;
			console.error(`SELFTEST figma redraw keeps focus on Test connection: during=${k1} after=${k2} -> ${k1 === "test" && k2 === "test" ? "OK" : "MISMATCH"}`);
			// another project: the half-typed link and the old state go, a new check runs
			window.crustFigma.projectChanged();
			await wait(100);
			const reset = `input="${panel.querySelector(".fp-file input")?.value}" busy=${window.crustFigma.state().busy}`;
			await until(idle);
			console.error(`SELFTEST figma project change: ${reset} -> ${reset === 'input="" busy=true' && !window.crustFigma.state().busy ? "OK" : "MISMATCH"}`);
			await crust.figma.stubMode("no-selection", {});
		}
		const input = panel.querySelector(".fp-file input");
		input.value = "not a link";
		[...panel.querySelectorAll(".fp-file button")].find((b) => b.textContent === "Save").click();
		await wait(300);
		console.error(`SELFTEST figma file link bad: "${text(".fp-file .fp-hint")}" -> ${/doesn't look like a Figma link/.test(text(".fp-file")) ? "OK" : "MISMATCH"}`);
		panel.querySelector(".fp-file input").value = "https://www.figma.com/design/AbCdEf123/Stub-Design-File";
		[...panel.querySelectorAll(".fp-file button")].find((b) => b.textContent === "Save").click();
		await wait(300);
		console.error(`SELFTEST figma file link set: "${text(".fp-file .fp-row")}" -> ${/File: Stub-Design-File/.test(text(".fp-file")) && !panel.querySelector(".fp-file input") && /Change/.test(text(".fp-file")) ? "OK" : "MISMATCH"}`);
		await shots("file-set");
		// stale green: ready, then Figma quits, then the next check says not connected
		await crust.figma.stubMode("ready", {});
		window.crustFigma.recheck();
		await until(idle);
		const green = pill.textContent;
		await crust.figma.stubMode("closed", { proc: { running: false, installed: true } });
		window.crustFigma.recheck();
		await until(idle);
		console.error(`SELFTEST figma stale green: "${green}" then "${pill.textContent}" -> ${green === "Figma: ready" && pill.textContent === "Figma: not connected" ? "OK" : "MISMATCH"}`);
		// keyboard and screen reader basics: pill is a button, Escape closes the panel, status is announced
		const announce = live.textContent;
		const tip = pill.title;
		console.error(`SELFTEST figma pill tooltip: "${tip}" -> ${/^Figma: not connected\. Checked (just now|\d+ s ago)$/.test(tip) ? "OK" : "MISMATCH"}`);
		// Escape with focus somewhere else leaves the panel alone
		const other = document.createElement("input");
		document.body.append(other);
		other.focus();
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		const stays = !panel.hidden && document.activeElement === other;
		other.remove();
		console.error(`SELFTEST figma escape elsewhere: panelOpen=${!panel.hidden} -> ${stays ? "OK" : "MISMATCH"}`);
		[...panel.querySelectorAll("button")].find((b) => b.textContent === "Test connection").focus();
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		await wait(100);
		console.error(`SELFTEST figma a11y: pill=${pill.tagName} live="${announce}" panelHidden=${panel.hidden} expanded=${pill.getAttribute("aria-expanded")} focusOnPill=${document.activeElement === pill} -> ${document.activeElement === pill && pill.tagName === "BUTTON" && announce === "Figma: not connected" && panel.hidden && pill.getAttribute("aria-expanded") === "false" ? "OK" : "MISMATCH"}`);
		// a script focus counts as keyboard focus (:focus-visible) when it moves on from a text field
		const probeInput = document.createElement("input");
		document.body.append(probeInput);
		await crust.selftest.focusEmulation(true);
		probeInput.focus();
		pill.focus();
		probeInput.remove();
		console.error(`SELFTEST figma pill focus ring: outline=${getComputedStyle(pill).outlineStyle} ${getComputedStyle(pill).outlineWidth} focus-visible=${pill.matches(":focus-visible")} focus=${pill.matches(":focus")} docFocus=${document.hasFocus()} -> ${pill.matches(":focus-visible") && getComputedStyle(pill).outlineStyle !== "none" ? "OK" : "MISMATCH"}`);
		await shots("pill-focus");
		pill.blur();
		await crust.figma.stubMode("closed", { clearFile: true });
		setTheme(theme0);
	});

	window.crustFigma = { projectChanged, recheck: refresh, openPanel: () => (panel.hidden ? open() : refresh()), state: () => ({ res, busy, open: !panel.hidden }) };
	paintPill();
})();
