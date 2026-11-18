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

	const LABELS = { pi: "Pi", auth: "Model provider", git: "Git", project: "Project", figma: "Figma" };
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
	// Every call a button makes is recorded with its answer; the self-test reads these records, not a log line.
	const calls = [];
	const record = (name, args, result) => (calls.push({ name, args, result }), result);
	const back = (button) => button?.isConnected && button.focus(); // after a dialog the app puts focus in the message box: bring it back

	// Install: the list of what will be installed and from where (from main, never from this window), a confirm, progress, a re-check.
	function applyProgress(e) {
		if (!install?.running) return;
		const steps = install.steps;
		if (e.kind === "step") steps.push({ id: e.id, text: `Installing ${e.text}`, state: "run" });
		else if (e.kind === "done") steps.filter((s) => s.id === e.id && s.state === "run").forEach((s) => (s.state = "done"));
		else if (e.kind === "fail") steps.filter((s) => s.id === e.id && s.state === "run").forEach((s) => ((s.state = "fail"), (s.text = `${s.text}: ${e.text}`)));
		else if (e.kind === "would") steps.push({ id: e.id, text: `Would run: ${e.text}`, state: "done" });
		else return;
		const last = steps.at(-1);
		if (last) announce(last.text);
		render();
	}
	crust.health.onInstallProgress(applyProgress);

	async function doInstall(row, button) {
		const only = row.action.id === "install-git" ? ["git"] : undefined;
		const arg = only ? { only } : {};
		const p = await crust.health.installPlan(arg);
		record("installPlan", arg, { ok: p.plan.ok, needs: p.needs, lines: p.plan.lines });
		if (!p.plan.ok) {
			install = { row: row.id, running: false, steps: [], error: p.plan.error === "Nothing to install." ? "Nothing is missing. Choose Check again." : p.plan.error, manual: p.plan.manual || [], details: "" };
			render();
			return back(button);
		}
		const answer = await showDialog({ method: "confirm", title: "Install what's missing?", message: p.plan.text, yesLabel: "Install", noLabel: "Cancel" });
		if (!answer.confirmed) return back(button);
		install = { row: row.id, running: true, steps: [], error: "", manual: [], details: "" };
		render();
		announce("Installing. This can take a few minutes.");
		const r = await crust.health.install(arg);
		record("install", arg, { ok: r.ok, dryRun: !!r.dryRun, lines: (r.lines || []).length });
		if (!install) install = { row: row.id, steps: [], manual: [], details: "" };
		install.running = false;
		if (r.health) {
			health = r.health;
			lastAt = Date.now();
		}
		if (r.ok) {
			if (r.dryRun) {
				install.steps = (r.lines || []).filter((l) => l.startsWith("WOULD ")).map((l) => ({ id: l.slice(6).split(":")[0], text: `Would run: ${l.slice(6).split(": ").slice(1).join(": ")}`, state: "done" }));
				install.steps.push({ id: "dry", text: "Test run: nothing was installed.", state: "done" });
			}
			else install = null; // the row now says what is installed
			announce(health?.ready ? "Installed. Everything needed is set up." : `Installed. Setup: ${counts()} done.`);
		} else {
			install.error = r.error || "The install did not finish.";
			install.manual = r.manual || [];
			install.details = r.details || "";
			announce(`The install stopped. ${install.error}`);
		}
		render();
		if (opened && !root.contains(document.activeElement)) focusFirst();
	}

	// Sign in: the provider list in the model panel, above this view. Back from the browser (window focus) or when the panel is
	// closed, the check runs again.
	let panelWatch = null;
	function signIn() {
		record("openContextPanel", { focusSubs: true }, null);
		openContextPanel({ focusSubs: true });
		panelWatch ||= new MutationObserver(() => {
			if (document.querySelector("#ctx-panel")) return;
			panelWatch.disconnect();
			panelWatch = null;
			if (opened) refresh({ fresh: true }).then(() => !root.contains(document.activeElement) && focusFirst());
		});
		panelWatch.observe(document.body, { childList: true });
	}

	// Choose folder: the existing picker, above this view. The repo-changed event checks again.
	function chooseFolder() {
		record("openRepoPicker", { cancellable: true }, null);
		openRepoPicker({ cancellable: true });
	}

	// Make it a Git project: a confirm that names the folder, then `git init` and nothing else.
	async function makeGitProject(row, button) {
		const repo = health?.facts?.project?.repo || info.repo;
		const answer = await showDialog({
			method: "confirm",
			title: "Make this a Git project?",
			message: `Pi Crust will run "git init" in:\n${repo}\n\nNothing is added or committed. Your files stay as they are.`,
			yesLabel: "Make it a Git project",
			noLabel: "Cancel",
		});
		if (!answer.confirmed) return back(button);
		const r = record("initGit", {}, await crust.repos.initGit());
		if (!r.ok) toast(r.error || "Couldn't make this a Git project", "error");
		else {
			refreshTree();
			loadChanges();
		}
		await refresh({ fresh: true });
		if (opened && !root.contains(document.activeElement)) focusFirst();
	}

	// Figma: out of this view, into the Design tab's Figma panel (it checks by itself when it opens).
	async function setupFigma() {
		record("openFigmaPanel", {}, null);
		if (!onb.skippedAt && !onb.doneAt) await mark("skippedAt");
		close({ restore: false });
		switchTab("design");
		window.crustFigma?.openPanel();
		$("#figma-pill")?.focus();
	}

	const ACTIONS = {
		recheck: () => refresh({ fresh: true, figma: true }),
		"install-pi": doInstall,
		"update-pi": doInstall,
		"install-git": doInstall,
		"sign-in": signIn,
		"choose-folder": chooseFolder,
		"init-git": makeGitProject,
		"setup-figma": setupFigma,
	};
	function runAction(row, button) {
		const fn = ACTIONS[row.action.id];
		return fn ? fn(row, button) : null;
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
		window.crustFirstTask?.restore(onb);
		return false;
	}

	// Ways back in: the palette (here), /setup (slash.js), the header pill, the Help menu, the model panel and the Pi-missing message.
	const prevActions = window.crustPaletteActions;
	window.crustPaletteActions = () => [
		...(prevActions?.() || []),
		{ label: "Setup checklist…", desc: "Pi, model provider, Git, project", run: () => open("palette") },
		{ label: "First task…", desc: "ask, change, undo", run: () => window.crustFirstTask?.show() },
	];
	crust.health.onOpen?.((what) => (what === "first-task" ? window.crustFirstTask?.show() : open("menu")));

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
		calls,
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
		const waitFor = async (fn, ms = 4000) => {
			for (let t = 0; t < ms && !fn(); t += 50) await wait(50);
		};
		const _setInstall = (v) => ((install = v), render());
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
		// --- install: the confirm lists exactly what main will install, Cancel changes nothing, Install runs the (dry-run) script ---
		// Git is installed (the common case): the confirm lists Node.js and Pi, no Git line, and the runner is asked for those only
		await setState({ pi: "missing", node: "missing" });
		calls.length = 0;
		rowsEl.querySelector('[data-action="install-pi"]').click();
		await waitFor(() => dialogOpen);
		const msg = $("#modal p")?.textContent || "";
		const plan = calls.find((c) => c.name === "installPlan")?.result;
		say("install confirm", dialogOpen && plan?.ok && plan.lines.length === 2 && plan.needs.join() === "node,pi" && plan.lines.every((l) => msg.includes(l)) && !/Git/.test(msg) && /^Pi Crust will install:/.test(msg) && /Nothing else on this computer is changed\./.test(msg) && /Pi, the coding agent, from the npm package @earendil-works\/pi-coding-agent/.test(msg) && !install, `lines=${plan?.lines.length} needs=[${plan?.needs}] git=${/Git/.test(msg)} title="${$("#modal h2")?.textContent}"`);
		await shot("3-install-confirm");
		$("#modal .modal-actions .secondary").click(); // Cancel
		await wait(200);
		say("install cancel", !dialogOpen && !install && !calls.some((c) => c.name === "install") && document.activeElement?.dataset.action === "install-pi", `focus="${document.activeElement?.textContent}"`);
		rowsEl.querySelector('[data-action="install-pi"]').click();
		await waitFor(() => dialogOpen);
		$("#modal .modal-actions button:last-child").click(); // Install
		await waitFor(() => calls.some((c) => c.name === "install"), 30000);
		const inst = calls.find((c) => c.name === "install")?.result;
		const would = install?.steps.filter((s) => s.text.startsWith("Would run:")).length;
		say("install dry run", inst?.ok && inst.dryRun && would === 2 && !install.steps.some((x) => /git/i.test(x.text)) && install.steps.at(-1).text === "Test run: nothing was installed." && !install.running && health.rows[0].state === "todo" && !!rowsEl.querySelector(".ob-progress"), `would=${would} piStillMissing=${health.rows[0].state === "todo"}`);
		await setState({ pi: "missing", node: "missing", git: "missing" }); // the progress states below show a Git row with its own button
		// progress, as it looks while the script runs (the events are fed in by hand; the real stream is covered by the health-install step)
		_setInstall({ row: "pi", running: true, steps: [{ id: "node", text: "Installing Node.js (current LTS)", state: "done" }, { id: "git", text: "Installing Git", state: "run" }], error: "", manual: [], details: "" });
		const prog = rowsEl.querySelector(".ob-progress");
		const gitBtn = rowsEl.querySelector('[data-action="install-git"]');
		const before = calls.length;
		gitBtn?.click();
		await wait(300);
		say("install progress", prog?.getAttribute("role") === "status" && prog.getAttribute("aria-live") === "polite" && !!prog.querySelector(".ob-bar") && !rowsEl.querySelector('.ob-row[data-id="pi"] .btn') && gitBtn?.getAttribute("aria-disabled") === "true" && !dialogOpen && calls.length === before, `steps=${prog?.querySelectorAll(".ob-step").length} otherButtonsDisabled=${gitBtn?.getAttribute("aria-disabled")}`);
		await shot("4-install-progress");
		applyProgress({ kind: "done", id: "git" });
		_setInstall({ row: "pi", running: false, steps: [{ id: "node", text: "Installing Node.js (current LTS)", state: "done" }, { id: "pi", text: "Installing Pi, the coding agent: exit 1", state: "fail" }], error: "The installer stopped (exit code 1).", manual: ["Open a new terminal and run: npm install -g @earendil-works/pi-coding-agent", "Then come back to Pi Crust and choose Check again."], details: "details" });
		say("install failed", !!rowsEl.querySelector(".ob-progress .ob-manual li") && [...rowsEl.querySelectorAll(".ob-progress .ob-link")].some((b) => b.textContent === "Copy details") && !!rowsEl.querySelector('[data-action="install-pi"]'), "manual steps, Copy details and the button to try again");
		await shot("4b-install-failed");
		_setInstall(null);
		// Git missing too: the same button lists all three, Cancel changes nothing
		await setState({ pi: "missing", node: "missing", git: "missing" });
		calls.length = 0;
		rowsEl.querySelector('[data-action="install-pi"]').click();
		await waitFor(() => dialogOpen);
		const plan3 = calls.find((c) => c.name === "installPlan")?.result;
		say("install confirm with Git missing", plan3?.ok && plan3.needs.join() === "node,git,pi" && /Git, from/.test($("#modal p")?.textContent || ""), `lines=${plan3?.lines.length}`);
		$("#modal .modal-actions .secondary").click();
		await wait(200);
		// everything installed: no install or update button on any row
		await setState({});
		say("nothing missing, no install button", !rowsEl.querySelector('[data-action="install-pi"], [data-action="update-pi"], [data-action="install-git"]') && health.needs.length === 0, `buttons=${[...rowsEl.querySelectorAll("[data-action]")].map((b) => b.dataset.action)}`);

		// signed out, no project, everything required done, each in turn
		await setState({ auth: "none" });
		say("signed out", matches() && dom()[1].hot && dom()[1].btn === "Sign in" && !dom()[0].hot && startBtn.disabled);
		await shot("5-signed-out");
		// sign in: the model panel opens above this view; closing it checks again (the stub flips to "signed in" meanwhile)
		calls.length = 0;
		rowsEl.querySelector('[data-action="sign-in"]').click();
		await wait(400);
		say("sign in button", calls.some((c) => c.name === "openContextPanel" && c.args.focusSubs === true) && !!$("#ctx-panel") && opened && Number(getComputedStyle($("#ctx-panel")).zIndex) > Number(getComputedStyle(root).zIndex), `panel=${!!$("#ctx-panel")} z=${getComputedStyle($("#ctx-panel")).zIndex}>${getComputedStyle(root).zIndex}`);
		await crust.health.stubSet({});
		closeContextPanel();
		await waitFor(() => health.rows[1].state === "ready", 4000);
		say("sign in checks again", health.rows[1].state === "ready" && health.rows[1].line === "Signed in to Claude." && !$("#ctx-panel") && rowsEl.querySelector('.ob-row[data-id="auth"]').classList.contains("ready"), `auth="${health.rows[1].line}"`);
		await setState({ auth: "none" });
		await setState({ project: "none" });
		say("no project", matches() && dom()[3].hot && dom()[3].btn === "Choose folder" && startBtn.disabled);
		await shot("6-no-project");
		// choose folder: the existing picker opens above this view (and Escape closes only the picker)
		const seenPicker = [];
		const realPicker = window.openRepoPicker;
		window.openRepoPicker = (...a) => (seenPicker.push(a), realPicker(...a));
		calls.length = 0;
		rowsEl.querySelector('[data-action="choose-folder"]').click();
		await wait(500);
		const pk = $("#repo-picker");
		say("choose folder", seenPicker.length === 1 && seenPicker[0][0]?.cancellable === true && !pk.hidden && opened && Number(getComputedStyle(pk).zIndex) > Number(getComputedStyle(root).zIndex), `picker.hidden=${pk.hidden} calls=${seenPicker.length}`);
		$("#picker-filter").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
		await wait(400);
		window.openRepoPicker = realPicker;
		say("escape closes the picker only", pk.hidden && opened && !root.hidden);
		await setState({ project: "notgit" });
		say("not a git project", matches() && dom()[3].hot && dom()[3].btn === "Make it a Git project");
		// make it a Git project: the confirm names the folder; Cancel runs nothing; Yes asks main (a selftest runs no git at all)
		calls.length = 0;
		rowsEl.querySelector('[data-action="init-git"]').click();
		await waitFor(() => dialogOpen);
		const gmsg = $("#modal p")?.textContent || "";
		say("git init confirm", dialogOpen && $("#modal h2").textContent === "Make this a Git project?" && gmsg.includes('"git init" in:\n/stub/notes') && /Nothing is added or committed\./.test(gmsg), `"${gmsg.replace(/\n/g, " / ")}"`);
		await shot("9-git-init-confirm");
		$("#modal .modal-actions .secondary").click();
		await wait(200);
		say("git init cancel", !dialogOpen && !calls.some((c) => c.name === "initGit") && document.activeElement?.dataset.action === "init-git");
		rowsEl.querySelector('[data-action="init-git"]').click();
		await waitFor(() => dialogOpen);
		$("#modal .modal-actions button:last-child").click();
		await waitFor(() => calls.some((c) => c.name === "initGit"), 8000);
		const gi = calls.find((c) => c.name === "initGit")?.result;
		say("git init asks main", gi?.ok === true && gi.selftest === true, JSON.stringify(gi));
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
		// --- ways back in: palette, /setup (with no Pi running), the window event, the model panel's empty state ---
		await setState({ pi: "missing", node: "missing" });
		const userMsgs = () => active.el.querySelectorAll(".msg.user").length;
		const sent0 = userMsgs();
		await openPalette("setup");
		await wait(300);
		const setupItem = paletteItems.find((i) => i.label === "Setup checklist…");
		say("palette lists setup", !!setupItem && typeof setupItem.run === "function", `items=${paletteItems.map((i) => i.label).join(" | ")}`);
		setupItem?.run();
		closePalette();
		await waitFor(() => opened);
		say("palette opens it", opened && !root.hidden);
		await skip();
		await openPalette("first task");
		await wait(300);
		say("palette lists first task", paletteItems.some((i) => i.label === "First task…"), `items=${paletteItems.map((i) => i.label).join(" | ")}`);
		closePalette();
		const readyBefore = state.ready;
		state.ready = false; // a chat with no running Pi
		const handled = await sendPrompt("/setup");
		await waitFor(() => opened);
		const toastText = [...document.querySelectorAll("#toasts .toast")].map((x) => x.textContent).join("|");
		say("/setup with no Pi", handled === true && opened && userMsgs() === sent0 && !/still starting|isn't running/.test(toastText), `handled=${handled} opened=${opened} messages=${userMsgs() - sent0} toasts="${toastText}"`);
		await skip();
		const other = await sendPrompt("/reload");
		state.ready = readyBefore;
		say("other commands still need Pi", other === false && !opened);
		window.dispatchEvent(new CustomEvent("crust:open-setup", { detail: { source: "pi-missing", chatId: active.id } }));
		await waitFor(() => opened);
		say("the Pi-missing button opens it", opened);
		await skip();
		const models0 = active.models;
		active.models = [];
		openContextPanel();
		await wait(300);
		const link = [...document.querySelectorAll("#ctx-panel .ctx-empty .ob-link")].find((b) => b.textContent === "Open setup");
		link?.click();
		await waitFor(() => opened);
		active.models = models0;
		say("model panel link", !!link && opened && !$("#ctx-panel"), `link=${!!link}`);
		await skip();
		// everything done: no pill
		await setState({ figma: "ready" });
		say("no pill when done", pill.hidden && health.ready);
		// the pill follows the health, and a failed state shows no stale "all ready"
		await setState({ pi: "missing", node: "missing" });
		say("pill returns", !pill.hidden && pill.textContent === "Setup: 2 of 4");
		// Figma: closes the view, opens the Design tab's Figma panel and puts focus on its pill
		await crust.health.stubSet({ figma: "not_reachable" });
		await open("test");
		await refresh({ fresh: true, figma: true });
		rowsEl.querySelector('[data-action="setup-figma"]').click();
		await waitFor(() => !!window.crustFigma?.state().open, 6000);
		say("figma", !opened && root.hidden && activeTab === "design" && window.crustFigma.state().open && document.activeElement === $("#figma-pill") && !!(await crust.health.onboarding()).skippedAt, `tab=${activeTab} panelOpen=${window.crustFigma?.state().open} focus="${document.activeElement?.id}"`);
		switchTab("browser");
		await crust.health.stubSet({});
		await refresh({ fresh: true });
		await crust.health.onboardingSet("skippedAt", null);
		setTheme(was);
		console.error(`SELFTEST onboarding shots: ${shots.join(" ; ")}`);
	}, "onboarding");
})();
