// Setup: the welcome view (first launch, and from every way back in), the "Setup: x of y" pill in the chat header and the checklist.
// Rows come from crust.health.check() (health-main.js, words in health-logic.js); this file only draws them and runs their one button.
//  - First launch (no onboarding.doneAt or skippedAt): the view opens by itself, in place of the repo picker (atStart, called by repos.js).
//  - "Skip for now" (Escape too) closes it and leaves the pill until every required row is done. "Start" needs them all and
//    hands over to the first-task card (first-task.js).
//  - It opens on the `crust:open-setup` window event (Pi missing), from the pill, the palette, /setup and the Help menu.
// Self-test step `onboarding`: every state through the stub (PI_CRUST_HEALTH_STUB={}), a screenshot of each in dark and light.
// Run: PI_CRUST_HEALTH_STUB={} PI_CRUST_SELFTEST_OFFSCREEN=1 PI_CRUST_SELFTEST_NOPROMPT=1 npm run selftest -- onboarding
"use strict";

(() => {
	const root = $("#onboarding");
	if (!root) return;
	const rowsEl = $("#ob-rows");
	const live = $("#ob-live");
	const pill = $("#setup-pill");
	const startBtn = $("#ob-start");
	const skipBtn = $("#ob-skip");
	const recheckBtn = $("#ob-recheck");
	const taskLink = $("#ob-first-task");

	const LABELS = { pi: "Pi", auth: "AI account", git: "Git", project: "Project", figma: "Figma" };
	const MARK = { ready: "✓", todo: "○", unknown: "–" };

	let health = null; // last result of crust.health.check()
	let opened = false;
	let opener = null; // what had focus before the view opened
	let onb = {}; // { doneAt, skippedAt, firstTaskDoneAt, ... }
	let seq = 0; // a newer check supersedes an older one
	let lastAt = 0;
	let announced = "";
	let focusPending = false; // the view just opened: once the first answer is in, focus goes to the highlighted button
	let install = null; // { row, running, steps: [{ id, text, state }], error, details, manual }: kept while the view is closed

	const announce = (text) => {
		if (text === announced) return;
		announced = text;
		live.textContent = text;
	};
	const counts = () => (health ? `${health.counts.done} of ${health.counts.total}` : "");

	// --- one row ------------------------------------------------------------------------------
	const markOf = (r) => (r.state === "ready" ? { glyph: MARK.ready, word: "Done" } : r.state === "unknown" ? { glyph: MARK.unknown, word: "Can't tell" } : r.optional ? { glyph: MARK.unknown, word: "Optional" } : { glyph: MARK.todo, word: "To do" });
	const firstId = () => health?.rows.find((r) => !r.optional && r.state !== "ready" && r.action)?.id;

	function progressEl() {
		const box = el("div", "ob-progress");
		box.setAttribute("role", "status");
		box.setAttribute("aria-live", "polite");
		for (const s of install.steps) {
			const row = el("div", `ob-step ${s.state}`);
			row.append(el("span", "mark", s.state === "done" ? "✓" : s.state === "fail" ? "✕" : "…"), el("span", "", s.text));
			box.append(row);
		}
		if (install.running) box.append(el("div", "ob-bar"));
		if (install.error) {
			box.append(el("div", "ob-step fail", install.error));
			if (install.manual?.length) {
				const ol = el("ol", "ob-manual");
				for (const t of install.manual) ol.append(el("li", "", t));
				box.append(ol);
			}
			if (install.details) {
				const copy = el("button", "ob-link", "Copy details");
				copy.type = "button";
				copy.onclick = () => {
					navigator.clipboard?.writeText(install.details);
					announce("Details copied.");
				};
				box.append(copy);
			}
		}
		return box;
	}

	function rowEl(r, first) {
		const li = el("li", `ob-row ${r.state}${first ? " first" : ""}`);
		li.dataset.id = r.id;
		const m = markOf(r);
		li.append(el("span", "ob-mark", m.glyph));
		li.firstChild.setAttribute("aria-hidden", "true");
		const text = el("div", "ob-text");
		const label = el("span", "ob-label");
		label.append(el("span", "fp-sr", `${m.word}. `), r.label);
		if (r.optional) label.append(el("span", "ob-optional", "Optional"));
		text.append(label, el("div", "ob-line", r.line));
		if (install && install.row === r.id) text.append(progressEl());
		li.append(text);
		if (r.action && !(install?.running && install.row === r.id)) {
			const b = el("button", first ? "btn" : "btn secondary", r.action.label);
			b.type = "button";
			b.dataset.action = r.action.id;
			if (install?.running) b.setAttribute("aria-disabled", "true");
			b.onclick = () => (install?.running ? null : runAction(r, b));
			li.append(b);
		}
		return li;
	}

	function skeleton() {
		return ["pi", "auth", "git", "project", "figma"].map((id) => rowEl({ id, label: LABELS[id], state: "unknown", optional: id === "figma", line: "Checking…", action: null }, false));
	}

	function render() {
		const keep = document.activeElement;
		const key = root.contains(keep) ? keep.dataset?.action && keep.closest(".ob-row")?.dataset.id + ":" + keep.dataset.action : null;
		const first = firstId();
		rowsEl.replaceChildren(...(health ? health.rows.map((r) => rowEl(r, r.id === first)) : skeleton()));
		rowsEl.setAttribute("aria-busy", String(!health));
		const ready = !!health?.ready;
		startBtn.disabled = !ready;
		startBtn.textContent = onb.firstTaskDoneAt ? "Close" : "Start";
		startBtn.title = ready ? "" : "Finish the steps above first";
		taskLink.hidden = !(onb.doneAt && !onb.firstTaskDoneAt && window.crustFirstTask?.hidden());
		if (key && opened) {
			const [id, action] = key.split(":");
			rowsEl.querySelector(`.ob-row[data-id="${id}"] [data-action="${action}"]`)?.focus();
		}
		if (opened && !root.contains(document.activeElement)) focusFirst();
		paintPill();
	}

	function focusFirst() {
		(rowsEl.querySelector(".ob-row.first .btn") || (startBtn.disabled ? skipBtn : startBtn)).focus();
	}

	function paintPill() {
		const show = !!health && !health.ready && !opened;
		pill.hidden = !show;
		if (!show) return;
		pill.textContent = `Setup: ${counts()}`;
		pill.title = "Open setup";
		pill.setAttribute("aria-label", `Setup: ${health.counts.done} of ${health.counts.total} steps done. Open setup.`);
	}

	// --- checking ------------------------------------------------------------------------------
	// fresh: forget the remembered Pi location and sign-in answer first (after an install, a sign-in, a folder change).
	async function refresh({ fresh = true, figma = opened } = {}) {
		const mine = ++seq;
		let r;
		try {
			r = await (fresh ? crust.health.recheck({ figma }) : crust.health.check({ figma }));
		} catch {
			return health;
		}
		if (mine !== seq) return health;
		health = r;
		lastAt = Date.now();
		if (opened && focusPending) {
			focusPending = false;
			render();
			focusFirst();
			announce(r.ready ? "Everything needed is set up." : `Setup: ${counts()} done.`);
			return r;
		}
		announce(r.ready ? "Everything needed is set up." : `Setup: ${counts()} done.`);
		render();
		return r;
	}

	// --- open and close ------------------------------------------------------------------------
	async function open(source = "menu") {
		if (opened) return focusFirst();
		opened = true;
		opener = document.activeElement;
		crust.browser.hide(true, "setup");
		root.hidden = false;
		pill.hidden = true;
		render();
		skipBtn.focus();
		focusPending = true;
		onb = (await crust.health.onboarding()) || {};
		await refresh({ fresh: true, figma: true });
		return source;
	}

	function close({ restore = true } = {}) {
		if (!opened) return;
		opened = false;
		root.hidden = true;
		crust.browser.hide(false, "setup");
		if (restore) {
			const back = opener && opener.isConnected && opener !== document.body ? opener : $("#input");
			back?.focus();
		}
		opener = null;
		paintPill();
	}

	async function mark(key) {
		const r = await crust.health.onboardingSet(key);
		if (r?.ok) onb = r.onboarding;
	}

	// Skip: keep the pill, and a project is still needed to work at all.
	async function skip() {
		if (!onb.skippedAt && !onb.doneAt) await mark("skippedAt");
		close();
		if (!info.repo) openRepoPicker();
	}
	async function start() {
		if (!health?.ready) return;
		if (!onb.doneAt) await mark("doneAt");
		close();
		if (!onb.firstTaskDoneAt) window.crustFirstTask?.start();
	}

	// --- row buttons ---------------------------------------------------------------------------
	const ACTIONS = {
		recheck: () => refresh({ fresh: true, figma: true }),
	};
	function runAction(row, button) {
		const fn = ACTIONS[row.action.id];
		if (fn) return fn(row, button);
	}

	// --- events --------------------------------------------------------------------------------
	for (const ev of ["mousedown", "keydown"]) root.addEventListener(ev, () => (focusPending = false), true); // the user moved: leave focus alone
	skipBtn.onclick = skip;
	startBtn.onclick = start;
	recheckBtn.onclick = () => refresh({ fresh: true, figma: true });
	taskLink.onclick = () => {
		close();
		window.crustFirstTask?.show();
	};
	pill.onclick = () => open("pill");
	window.addEventListener("crust:open-setup", (e) => open(e.detail?.source || "event"));
	crust.repos.onChanged(() => {
		if (health) refresh({ fresh: true });
	});
	// Back from a browser sign-in or an installer: look again (not more than every few seconds).
	window.addEventListener("focus", () => {
		if ((opened || (health && !health.ready)) && Date.now() - lastAt > 3000 && !install?.running) refresh({ fresh: true });
	});
	window.addEventListener(
		"keydown",
		(e) => {
			if (!opened || e.defaultPrevented) return;
			const other = dialogOpen || !$("#repo-picker").hidden || (typeof ctxOpen !== "undefined" && ctxOpen);
			if (other) return;
			if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				skip();
			} else if (e.key === "Tab") {
				const items = [...root.querySelectorAll("button:not([disabled]):not([hidden]):not([aria-disabled='true'])")].filter((b) => b.offsetParent);
				if (!items.length) return;
				const i = items.indexOf(document.activeElement);
				const next = e.shiftKey ? (i <= 0 ? items.at(-1) : items[i - 1]) : i < 0 || i === items.length - 1 ? items[0] : items[i + 1];
				e.preventDefault();
				next.focus();
			}
		},
		true,
	);

	// repos.js calls this once the app knows its repo: true when the view opened, so the repo picker stays closed.
	async function atStart({ force = false } = {}) {
		onb = (await crust.health.onboarding()) || {};
		if (info.selftest && !force) return false; // a test run opens it only when asked
		if (!onb.doneAt && !onb.skippedAt) {
			open("first-launch");
			return true;
		}
		refresh({ fresh: false, figma: false }); // for the pill
		return false;
	}

	window.crustOnboarding = {
		open,
		close,
		refresh,
		atStart,
		isOpen: () => opened,
		state: () => ({ health, onb, install, opened }),
		_setInstall: (v) => ((install = v), render()),
		_render: render,
		_paintPill: paintPill,
		_setOnb: (v) => (onb = v),
	};
	window.addEventListener("crust:onboarding-changed", async () => {
		onb = (await crust.health.onboarding()) || {};
		if (opened) render();
	});

	// --- selftest --------------------------------------------------------------------------------
	// States, each driven through the health stub. The words are compared with what health-logic says (the `health` step checks them
	// against the plan's table); here the point is that the view shows them, marks them, and highlights the right button.
	selftestSteps.push(async ({ snap, wait }) => {
		try {
			await crust.health.stubSet({});
		} catch {
			return console.error("SELFTEST onboarding: needs PI_CRUST_HEALTH_STUB={} in the environment -> MISMATCH");
		}
		const was = themeSetting();
		const shots = [];
		const say = (name, ok, extra = "") => console.error(`SELFTEST onboarding ${name}${extra ? ` ${extra}` : ""} -> ${ok ? "OK" : "MISMATCH"}`);
		const shot = async (name) => {
			for (const theme of ["dark", "light"]) {
				setTheme(theme);
				await wait(450);
				const file = await snap(`ob-${name}-${theme}`);
				shots.push(`${name}|${theme}|${file}`);
			}
		};
		const dom = () => [...rowsEl.querySelectorAll(".ob-row")].map((li) => ({ id: li.dataset.id, cls: li.className, mark: li.querySelector(".ob-mark").textContent, sr: li.querySelector(".fp-sr").textContent, line: li.querySelector(".ob-line").textContent, btn: li.querySelector(".btn")?.textContent || null, hot: !!li.querySelector(".btn:not(.secondary)") }));
		const setState = async (stub) => {
			await crust.health.stubSet(stub);
			await refresh({ fresh: true, figma: true });
		};
		// does the view match the health result, row for row?
		const matches = () => {
			const d = dom();
			const h = health.rows;
			const first = firstId();
			return d.length === h.length && h.every((r, i) => d[i].id === r.id && d[i].line === r.line && d[i].btn === (r.action ? r.action.label : null) && d[i].hot === (r.id === first && !!r.action) && d[i].mark === markOf(r).glyph && d[i].sr.startsWith(markOf(r).word));
		};
		await crust.health.onboardingSet("skippedAt", null);
		await crust.health.onboardingSet("doneAt", null);

		// first launch, nothing set up: opens by itself and the repo picker stays shut
		switchTab("browser");
		await wait(300);
		const opens = await atStart({ force: true });
		await crust.health.stubSet({ pi: "missing", node: "missing", auth: "none", git: "missing", project: "none", figma: "not_reachable" });
		await refresh({ fresh: true, figma: true });
		const b0 = await crust.selftest.bounds();
		say("first launch", opens === true && opened && matches() && $("#repo-picker").hidden && !startBtn.textContent.startsWith("Close") && startBtn.disabled && dom()[0].hot && dom().filter((r) => r.hot).length === 1, `rows=${dom().map((r) => r.id + ":" + r.mark).join(",")} start.disabled=${startBtn.disabled} picker.hidden=${$("#repo-picker").hidden}`);
		say("viewer hidden while open", b0.visible === false && b0.hidden.includes("setup"), `visible=${b0.visible} reasons=[${b0.hidden}]`);
		say("focus in the view", root.contains(document.activeElement) && document.activeElement.dataset.action === "install-pi", `focus="${document.activeElement.textContent}"`);
		await shot("1-nothing-set-up");

		// Pi missing, everything else fine: the Pi button is the highlighted one, sign-in waits for it
		await setState({ pi: "missing", node: "missing" });
		const d1 = dom();
		say("pi missing", matches() && d1[0].hot && d1[0].btn === "Install Pi" && d1[1].btn === null && d1[2].mark === "✓" && startBtn.disabled && d1[4].mark === "–" && /Optional/.test(d1[4].sr + rowsEl.children[4].textContent), `${d1.map((r) => r.id + ":" + r.mark + ":" + (r.btn || "-")).join(" ")}`);
		await shot("2-pi-missing");

		// signed out, no project, everything required done, each in turn
		await setState({ auth: "none" });
		say("signed out", matches() && dom()[1].hot && dom()[1].btn === "Sign in" && !dom()[0].hot && startBtn.disabled);
		await shot("5-signed-out");
		await setState({ project: "none" });
		say("no project", matches() && dom()[3].hot && dom()[3].btn === "Choose folder" && startBtn.disabled);
		await shot("6-no-project");
		await setState({ project: "notgit" });
		say("not a git project", matches() && dom()[3].hot && dom()[3].btn === "Make it a Git project");
		await setState({ pi: "unknown" });
		say("cant tell", matches() && dom()[0].mark === "–" && dom()[0].sr.startsWith("Can't tell") && dom()[0].btn === "Check again" && dom()[0].hot);
		focusPending = false;
		rowsEl.querySelector(".ob-row .btn")?.focus(); // the user has just pressed the last button: it goes away when everything is done
		await setState({ figma: "ready" });
		const d2 = dom();
		say("all ready", matches() && health.ready && d2.every((r) => r.mark === "✓") && !startBtn.disabled && !d2.some((r) => r.hot) && document.activeElement === startBtn, `start.disabled=${startBtn.disabled} counts=${counts()} focus="${document.activeElement.textContent}"`);
		await shot("7-all-ready");

		// the pill: some required rows left, view closed
		await setState({ auth: "none", project: "none", figma: "ready" });
		await skip();
		const doneNow = await crust.health.onboarding();
		say("skip", !opened && root.hidden && !!doneNow.skippedAt && !pill.hidden && pill.textContent === "Setup: 2 of 4" && pill.getAttribute("aria-label") === "Setup: 2 of 4 steps done. Open setup.", `pill="${pill.textContent}" skippedAt=${!!doneNow.skippedAt}`);
		const b1 = await crust.selftest.bounds();
		say("viewer back after skip", !b1.hidden.includes("setup"), `reasons=[${b1.hidden}]`);
		await shot("8-header-pill");
		pill.click();
		await wait(200);
		say("pill reopens", opened && !root.hidden && pill.hidden && root.contains(document.activeElement), `focus="${document.activeElement.textContent}"`);
		// Escape skips and gives focus back to the pill's place
		window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
		await wait(300);
		say("escape skips", !opened && root.hidden && !pill.hidden);
		// everything done: no pill
		await setState({ figma: "ready" });
		say("no pill when done", pill.hidden && health.ready);
		// the pill follows the health, and a failed state shows no stale "all ready"
		await setState({ pi: "missing", node: "missing" });
		say("pill returns", !pill.hidden && pill.textContent === "Setup: 2 of 4");
		await crust.health.stubSet({});
		await refresh({ fresh: true });
		await crust.health.onboardingSet("skippedAt", null);
		setTheme(was);
		console.error(`SELFTEST onboarding shots: ${shots.join(" ; ")}`);
	}, "onboarding");
})();
