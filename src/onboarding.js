// Setup: the welcome view (first launch, and from every way back in), the "Setup: x of y" pill in the chat header and the checklist.
// Rows come from crust.health.check() (health-main.js, words in health-logic.js); this file only draws them and runs their one button.
//  - First launch (no onboarding.doneAt or skippedAt): the view opens by itself, in place of the repo picker (atStart, called by repos.js).
//    Existing users who just updated are the same case, but when the first check finds every required row ready and a project is open,
//    setup is quietly marked done: no view, no first-task card, no pill. Only people with something missing see the welcome view.
//  - No check at startup once setup is done and the last check was ready (onboarding.lastReadyAt, kept by main). A check runs when the
//    view opens, on "Check again", when Pi fails to start, and after an install or a sign-in.
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
	const appEl = $("#app");

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
	let checking = 0; // checks in flight
	let liveRows = {}; // rows that came in while a check is still running ("health:row"), by id

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
		if (install.running) {
				box.append(el("div", "ob-bar"));
				const cancel = el("button", "ob-link", install.cancelling ? "Stopping…" : "Cancel install");
				cancel.type = "button";
				cancel.dataset.action = "cancel-install";
				cancel.onclick = () => {
					if (install.cancelling) return;
					install.cancelling = true;
					record("installCancel", {}, null);
					crust.health.installCancel();
					announce("Stopping the install.");
					render();
				};
				box.append(cancel);
			}
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

	const skeletonRow = (id) => ({ id, label: LABELS[id], state: "unknown", optional: id === "figma", line: "Checking…", action: null });
	// The last answer, with the rows of a check that is still running laid over it: each row shows as soon as its facts are in.
	function shownRows() {
		const base = health ? health.rows : ["pi", "auth", "git", "project", "figma"].map(skeletonRow);
		return base.map((r) => liveRows[r.id] || r);
	}
	crust.health.onRow?.((row) => {
		if (!checking || !row?.id) return;
		liveRows[row.id] = row;
		render();
	});

	function render() {
		const keep = document.activeElement;
		const key = root.contains(keep) ? keep.dataset?.action && keep.closest(".ob-row")?.dataset.id + ":" + keep.dataset.action : null;
		const shown = shownRows();
		const first = shown.find((r) => !r.optional && r.state !== "ready" && r.action)?.id;
		rowsEl.replaceChildren(...shown.map((r) => rowEl(r, r.id === first)));
		rowsEl.setAttribute("aria-busy", String(!health && checking > 0));
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
		if (!checking++) liveRows = {};
		try {
			r = await (fresh ? crust.health.recheck({ figma }) : crust.health.check({ figma }));
		} catch {
			return health;
		} finally {
			if (!--checking) liveRows = {};
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
		appEl.inert = true; // nothing behind the view takes focus or clicks
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
		appEl.inert = false;
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

	// The confirm is enforced in main: installPlan hands out a one-time token for exactly the list shown, install needs it. When what is
	// missing changed meanwhile, main refuses and the list is shown again (once).
	async function doInstall(row, button, again = false) {
		const only = row.action.id === "install-git" ? ["git"] : undefined;
		const arg = only ? { only } : {};
		const p = await crust.health.installPlan(arg);
		record("installPlan", arg, { ok: p.plan.ok, needs: p.needs, lines: p.plan.lines, token: !!p.token });
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
		const r = await crust.health.install({ token: p.token });
		record("install", arg, { ok: r.ok, dryRun: !!r.dryRun, lines: (r.lines || []).length, changed: !!r.changed, cancelled: !!r.cancelled });
		if (r.changed && !again) {
			install = null;
			render();
			return doInstall(row, button, true); // what is missing changed: ask again with the new list
		}
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
			install.cancelling = false;
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
	// Main names the folder and hands out a one-time token for exactly that folder; `git init` needs it.
	async function makeGitProject(row, button) {
		const plan = record("initGitPlan", {}, await crust.repos.initGitPlan());
		if (!plan.ok) {
			toast(plan.error || "Couldn't make this a Git project", "error");
			await refresh({ fresh: true });
			return back(button);
		}
		const answer = await showDialog({
			method: "confirm",
			title: "Make this a Git project?",
			message: `Pi Crust will run "git init" in:\n${plan.folder}\n\nNothing is added or committed. Your files stay as they are.`,
			yesLabel: "Make it a Git project",
			noLabel: "Cancel",
		});
		if (!answer.confirmed) return back(button);
		const r = record("initGit", {}, await crust.repos.initGit(plan.token));
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
		// Setup done and the last check said ready: no check at all at startup.
		if (onb.doneAt && onb.lastReadyAt) {
			window.crustFirstTask?.restore(onb);
			return false;
		}
		// Done or skipped, but the last check was not ready: look once, for the pill.
		if (onb.doneAt || onb.skippedAt) {
			refresh({ fresh: false, figma: false });
			window.crustFirstTask?.restore(onb);
			return false;
		}
		// Never set up: a new user, or an existing one who just updated. Without a project nothing can be ready, so skip the check.
		if (info.repo) {
			const r = await refresh({ fresh: false, figma: false });
			if (r?.ready) {
				await quietDone();
				return false;
			}
		}
		open("first-launch");
		return true;
	}
	// An existing user whose machine is already set up: setup counts as done, and the first-task card stays away (still there in the
	// view's link, the palette and the Help menu).
	async function quietDone() {
		await mark("doneAt");
		await mark("firstTaskHiddenAt");
		window.crustFirstTask?.restore(onb);
		paintPill();
	}
	// Pi failed to start (not found, or it crashed): look again, for the pill and the view. Not while a check is already running.
	crust.pi.onExit?.((e) => {
		if (!(e && (e.notInstalled || e.error || (e.code != null && e.code !== 0)))) return;
		if (!checking && !install?.running) refresh({ fresh: true });
	});

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
		_quietDone: quietDone,
		_seq: () => seq,
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
		// Layers: nothing may sit on top of a button, and nothing of the app may show through the view.
		const shown = (b) => b.offsetParent !== null || getComputedStyle(b).position === "fixed";
		const covered = (btns) => btns.filter(shown).filter((b) => {
			b.scrollIntoView?.({ block: "nearest" });
			const r = b.getBoundingClientRect();
			const e = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
			const ok = !!e && (e === b || b.contains(e));
			if (!ok) console.error(`  covered: "${b.textContent}" by ${e?.tagName}#${e?.id}.${e?.className}`);
			return !ok;
		});
		const layerCheck = (name, sel) => {
			const btns = [...document.querySelectorAll(sel)].filter(shown);
			const bad = covered(btns);
			say(name, btns.length > 0 && !bad.length, `buttons=${btns.length} covered=[${bad.map((b) => b.textContent)}]`);
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
		await crust.health.onboardingSet("lastReadyAt", null);
		await crust.health.stubSet({ pi: "missing", node: "missing", auth: "none", git: "missing", project: "none", figma: "not_reachable" });
		const opens = await atStart({ force: true });
		await refresh({ fresh: true, figma: true });
		const b0 = await crust.selftest.bounds();
		say("first launch", opens === true && opened && matches() && $("#repo-picker").hidden && !startBtn.textContent.startsWith("Close") && startBtn.disabled && dom()[0].hot && dom().filter((r) => r.hot).length === 1, `rows=${dom().map((r) => r.id + ":" + r.mark).join(",")} start.disabled=${startBtn.disabled} picker.hidden=${$("#repo-picker").hidden}`);
		say("viewer hidden while open", b0.visible === false && b0.hidden.includes("setup"), `visible=${b0.visible} reasons=[${b0.hidden}]`);
		say("focus in the view", root.contains(document.activeElement) && document.activeElement.dataset.action === "install-pi", `focus="${document.activeElement.textContent}"`);
		const bg = getComputedStyle(root).backgroundColor;
		const rb = root.getBoundingClientRect();
		say("view fills the window, opaque", rb.width === innerWidth && rb.height === innerHeight && !/rgba\(.*,\s*0(\.\d+)?\)$/.test(bg) && bg === getComputedStyle(document.body).backgroundColor, `box=${rb.width}x${rb.height} window=${innerWidth}x${innerHeight} bg=${bg}`);
		say("app behind the view is inert", appEl.inert === true && !appEl.contains(document.activeElement), `inert=${appEl.inert}`);
		toast("Selftest toast: must show above the view", "error", { label: "Toast button", onClick() {} });
		await wait(100);
		layerCheck("view buttons uncovered, toast present", "#onboarding button");
		const tb = $("#toasts .toast").getBoundingClientRect();
		const te = document.elementFromPoint(tb.left + tb.width / 2, tb.top + tb.height / 2);
		const tz = Number(getComputedStyle($("#toasts")).zIndex);
		say("toast is visible above the view", !!te && $("#toasts").contains(te) && tz > Number(getComputedStyle(root).zIndex) && tz > Number(getComputedStyle($("#modal-backdrop")).zIndex), `top element=${te?.tagName}.${te?.className} toast z=${tz} view z=${getComputedStyle(root).zIndex} confirm z=${getComputedStyle($("#modal-backdrop")).zIndex}`);
		const tbtn = $("#toasts .toast button");
		const tbr = tbtn.getBoundingClientRect();
		const tbe = document.elementFromPoint(tbr.left + tbr.width / 2, tbr.top + tbr.height / 2);
		say("toast button reachable over the view", tbe === tbtn || tbtn.contains(tbe));
		await shot("1-nothing-set-up");
		$("#toasts").replaceChildren();

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
		layerCheck("install confirm buttons uncovered", "#modal button");
		say("install confirm above the view", Number(getComputedStyle($("#modal-backdrop")).zIndex) >= Number(getComputedStyle(root).zIndex) && !!(root.compareDocumentPosition($("#modal-backdrop")) & Node.DOCUMENT_POSITION_FOLLOWING), `view z=${getComputedStyle(root).zIndex} confirm z=${getComputedStyle($("#modal-backdrop")).zIndex}`);
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
		const cancelBtn = rowsEl.querySelector('.ob-progress [data-action="cancel-install"]');
		say("install cancel button", !!cancelBtn && cancelBtn.textContent === "Cancel install", `button=${cancelBtn?.textContent}`);
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
		const gplan = calls.find((c) => c.name === "initGitPlan")?.result;
		say("git init confirm", dialogOpen && gplan?.ok && !!gplan.token && $("#modal h2").textContent === "Make this a Git project?" && gmsg.includes(`"git init" in:\n${gplan.folder}`) &&/Nothing is added or committed\./.test(gmsg), `"${gmsg.replace(/\n/g, " / ")}"`);
		layerCheck("git init confirm buttons uncovered", "#modal button");
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
		const spent = await crust.repos.initGit(gplan.token); // the token was used by the click above: a second call does nothing
		const bare = await crust.repos.initGit(undefined);
		say("git init needs a fresh token", spent.ok === false && spent.noToken === true && bare.ok === false && bare.noToken === true, JSON.stringify([spent, bare]));
		// a failed git init shows its error above the view
		const realPlan = crust.repos.initGitPlan;
		toast("Selftest: git init failed", "error");
		await wait(100);
		const ft = [...document.querySelectorAll("#toasts .toast")].at(-1).getBoundingClientRect();
		const fe = document.elementFromPoint(ft.left + ft.width / 2, ft.top + ft.height / 2);
		say("git init error toast is visible", !!fe && $("#toasts").contains(fe), `top=${fe?.tagName}.${fe?.className}`);
		$("#toasts").replaceChildren();
		await setState({ pi: "unknown" });
		say("cant tell", matches() && dom()[0].mark === "–" && dom()[0].sr.startsWith("Can't tell") && dom()[0].btn === "Check again" && dom()[0].hot);
		focusPending = false;
		rowsEl.querySelector(".ob-row .btn")?.focus(); // the user has just pressed the last button: it goes away when everything is done
		await setState({ figma: "ready" });
		const d2 = dom();
		say("all ready", matches() && health.ready && d2.every((r) => r.mark === "✓") && !startBtn.disabled && !d2.some((r) => r.hot) && document.activeElement === startBtn, `start.disabled=${startBtn.disabled} counts=${counts()} focus="${document.activeElement.textContent}"`);
		await shot("7-all-ready");
		// the view at the smallest window the app allows, and at a large one (most to show: every row still to do)
		await setState({ pi: "missing", node: "missing", git: "missing", auth: "none", project: "none", figma: "not_reachable" });
		for (const [name, w, h] of [["18-min-size", 1000, 600], ["19-large", 2560, 1440]]) {
			const got = await crust.selftest.resize(w, h);
			await wait(500);
			const r = root.getBoundingClientRect();
			const colBox = root.querySelector(".ob-col").getBoundingClientRect();
			const btns = [...root.querySelectorAll("button")];
			const bad = covered(btns);
			const inside = btns.filter(shown).every((b) => { const x = b.getBoundingClientRect(); return x.left >= 0 && x.right <= innerWidth + 0.5; });
			say(`window ${name}`, r.width === innerWidth && r.height === innerHeight && root.scrollWidth <= root.clientWidth && inside && !bad.length && colBox.width <= 600.5, `window=${got} inner=${innerWidth}x${innerHeight} column=${Math.round(colBox.width)}x${Math.round(colBox.height)} scrolls=${root.scrollHeight > root.clientHeight} covered=[${bad.map((b) => b.textContent)}]`);
			root.scrollTop = 0;
			await shot(name);
		}
		await crust.selftest.resize(1680, 1000);
		await wait(400);
		await setState({});

		// --- startup (atStart, forced): existing users and the no-probe rule ---
		const resetOnb = async () => {
			for (const k of ["doneAt", "skippedAt", "firstTaskDoneAt", "firstTaskHiddenAt", "lastReadyAt"]) await crust.health.onboardingSet(k, null);
		};
		if (opened) close();
		// an existing user: nothing set up yet in settings, every required row ready, a project open -> done quietly
		await resetOnb();
		await crust.health.stubSet({});
		const quiet = await atStart({ force: true });
		await wait(300);
		const qo = await crust.health.onboarding();
		say("existing user: quietly done", quiet === false && !opened && root.hidden && !!qo.doneAt && !!qo.firstTaskHiddenAt && !qo.firstTaskDoneAt && pill.hidden && !window.crustFirstTask.visible() && !appEl.inert, `opened=${opened} doneAt=${!!qo.doneAt} card=${window.crustFirstTask.visible()} pill.hidden=${pill.hidden} info.repo=${!!info.repo}`);
		// the same first check with something missing: the welcome view opens
		close();
		await resetOnb();
		await crust.health.stubSet({ pi: "missing", node: "missing" });
		const loud = await atStart({ force: true });
		const lo = await crust.health.onboarding();
		say("something missing: welcome view opens", loud === true && opened && !root.hidden && !lo.doneAt && appEl.inert, `opened=${opened} doneAt=${!!lo.doneAt}`);
		close();
		say("view closed: app is not inert", appEl.inert === false);
		// setup done and the last check was ready: no check at startup at all
		await resetOnb();
		await crust.health.onboardingSet("doneAt");
		await crust.health.onboardingSet("lastReadyAt");
		await crust.health.stubSet({ pi: "missing", node: "missing" }); // would show a pill if anyone looked
		const s0 = seq;
		const quietStart = await atStart({ force: true });
		await wait(300);
		say("done and ready: no check at startup", quietStart === false && seq === s0 && !opened, `checks=${seq - s0}`);
		// done, but the last check was not ready: one look, for the pill
		await crust.health.onboardingSet("lastReadyAt", null);
		const s1 = seq;
		await atStart({ force: true });
		await waitFor(() => seq > s1 && !checking, 5000);
		say("done but last check not ready: one check", seq === s1 + 1 && !pill.hidden, `checks=${seq - s1} pill.hidden=${pill.hidden}`);
		await resetOnb();
		onb = (await crust.health.onboarding()) || {};
		await crust.health.stubSet({});
		await refresh({ fresh: true });

		// the pill: some required rows left, view closed
		await setState({ auth: "none", project: "none", figma: "ready" });
		await skip();
		const doneNow = await crust.health.onboarding();
		say("skip", !opened && root.hidden && !!doneNow.skippedAt && !pill.hidden && pill.textContent === "Setup: 2 of 4" && pill.getAttribute("aria-label") === "Setup: 2 of 4 steps done. Open setup.", `pill="${pill.textContent}" skippedAt=${!!doneNow.skippedAt}`);
		const b1 = await crust.selftest.bounds();
		say("viewer back after skip", !b1.hidden.includes("setup"), `reasons=[${b1.hidden}]`);
		await shot("8-header-pill");
		toast("Selftest toast: must not cover the pill", "warning");
		await wait(100);
		layerCheck("header pill uncovered, toast present", "#setup-pill");
		$("#toasts").replaceChildren();
		// the first-task card, with a toast present
		await crust.health.onboardingSet("doneAt");
		window.crustFirstTask?.start();
		await wait(300);
		toast("Selftest toast: must not cover the card", "warning");
		await wait(100);
		layerCheck("first-task card buttons uncovered, toast present", "#first-task button");
		$("#toasts").replaceChildren();
		window.crustFirstTask?.hide();
		await crust.health.onboardingSet("firstTaskHiddenAt", null);
		await crust.health.onboardingSet("doneAt", null);
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
		// A message sent before Pi is ready still gets its warning ...
		const early = [...document.querySelectorAll("#toasts .toast")].some((x) => x.textContent === "Pi is still starting…");
		say("other commands still need Pi", other === false && !opened && early, `toast=${early}`);
		// ... and this test's own toast must not outlive it: it used to sit over the first-task card in the next step's screenshots.
		$("#toasts").replaceChildren();
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
