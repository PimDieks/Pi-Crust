// The guided first task: a card above the message box with three steps (ask, change, undo). Each step ticks from a real event:
// Pi's records (crust.pi.onRecord), the changed paths with README.md's stamp (snapshots, see below) and a finished restore (hook rewind:restored).
// The card belongs to the chat that was active when it started: records, snapshots and restores of other chats never tick it.
// The card puts the suggested text in the message box. It never sends: the user presses Enter.
// The steps and their rules are in first-task-logic.js. "Hide" puts the card away (onboarding.firstTaskHiddenAt); it comes back from the
// welcome view, the palette, /setup's view and the Help menu. Done is saved once, at the end (onboarding.firstTaskDoneAt).
// Self-test step `first-task`: stubbed events through the same handlers, never a prompt to Pi.
// Run: PI_CRUST_HEALTH_STUB={} PI_CRUST_SELFTEST_OFFSCREEN=1 PI_CRUST_SELFTEST_NOPROMPT=1 npm run selftest -- first-task
"use strict";

(() => {
	const card = $("#first-task");
	if (!card) return;

	let state = FirstTask.initial();
	let shown = false; // the card is on screen
	let hidden = false; // the user put it away (remembered in settings)
	let announced = "";
	let pointTimer = null;

	// Snapshots: the changed paths of a chat's folder plus README.md's modification time, so "README.md itself changed because of this
	// turn" can be told even when the README was already modified. The source is replaceable for the self-test.
	const defaultSource = async (chatId) => {
		const [st, rd] = await Promise.all([crust.fs.gitStatus(false, chatId), crust.fs.stat(FirstTask.README).catch(() => null)]);
		return { paths: Object.keys(st?.files || {}), readme: rd && rd.exists ? rd.mtime : null };
	};
	let source = defaultSource;
	async function snapshot(chatId, baseline, paths) {
		if (!chatId || (state.phase !== "step1" && state.phase !== "step2") || chatId !== state.chatId) return;
		try {
			const got = paths ? { paths, readme: (await defaultSource(chatId)).readme } : await source(chatId);
			if (chatId === state.chatId) apply({ type: "snapshot", chatId, baseline: !!baseline, paths: got.paths, readme: got.readme });
		} catch {}
	}

	const live = el("span", "fp-sr");
	live.setAttribute("role", "status");
	live.setAttribute("aria-live", "polite");
	const say = (t) => {
		if (t === announced) return;
		announced = t;
		live.textContent = t;
	};
	const btn = (label, cls, onClick) => {
		const b = el("button", `btn ${cls}`, label);
		b.type = "button";
		b.onclick = onClick;
		return b;
	};
	const save = async (key, clear) => {
		try {
			await crust.health.onboardingSet(key, clear ? null : undefined);
		} catch {}
		window.dispatchEvent(new Event("crust:onboarding-changed"));
	};

	// --- the card ------------------------------------------------------------------------------
	function render() {
		card.hidden = !shown || state.phase === "idle";
		if (card.hidden) return;
		const v = FirstTask.view(state);
		const head = el("div", "ft-head");
		head.append(el("span", "ft-title", "First task"));
		const hide = el("button", "ft-hide", v.done ? "Close" : "Hide");
		hide.type = "button";
		hide.onclick = v.done ? finish : hideCard;
		head.append(hide);
		const parts = [head];
		if (v.done) {
			parts.push(el("p", "ft-done", v.doneText));
		} else {
			const ol = el("ol", "ft-steps");
			ol.setAttribute("role", "list");
			for (const st of v.steps) {
				const li = el("li", `ft-step ${st.state}`);
				if (st.state === "now") li.setAttribute("aria-current", "step");
				li.append(el("span", "mark", st.state === "done" ? "✓" : st.state === "now" ? "●" : "○"));
				const body = el("div");
				const name = el("div", "ft-name");
				name.append(el("span", "fp-sr", st.state === "done" ? "Done. " : st.state === "now" ? "Now. " : "Later. "), st.title);
				body.append(name);
				if (st.state === "now") {
					body.append(el("div", "ft-hint", v.failed ? `${v.retryHint} The text goes back in the message box.` : st.hint));
					const act = el("div", "ft-act");
					if (st.prompt) act.append(btn(v.failed ? "Try again" : st.button, "", () => put(st)));
					else act.append(btn(st.button, "", pointAtRewind));
					body.append(act);
				}
				li.append(body);
				ol.append(li);
			}
			parts.push(ol);
		}
		parts.push(live);
		const keep = document.activeElement?.closest?.("#first-task") ? document.activeElement.className + document.activeElement.textContent : null;
		card.replaceChildren(...parts);
		if (keep) [...card.querySelectorAll("button")].find((b) => b.className + b.textContent === keep)?.focus();
		placeToasts?.();
	}

	// --- the buttons ---------------------------------------------------------------------------
	// The text goes in the message box; the user sends it. A draft already there is only replaced after asking.
	async function put(step) {
		if (state.failed) apply({ type: "retry" });
		const input = $("#input");
		if (input.value.trim() && input.value.trim() !== step.prompt) {
			const ok = await showDialog({ method: "confirm", title: "Replace the draft?", message: "The message box has text. Replace it with the suggested text?", yesLabel: "Replace", noLabel: "Keep my draft" });
			if (!ok.confirmed) return input.focus();
		}
		input.value = step.prompt;
		input.dispatchEvent(new Event("input", { bubbles: true }));
		input.focus();
		input.setSelectionRange(input.value.length, input.value.length);
		say("The text is in the message box. Press Enter to send it.");
	}

	// Step 3: light up the Rewind button of your last message (the bar normally shows on hover).
	function pointAtRewind() {
		const nodes = active?.el?.querySelectorAll(".msg.user");
		const node = nodes?.[nodes.length - 1];
		if (!node) return say("Send a message first, then hover it to find Rewind.");
		clearTimeout(pointTimer);
		document.querySelectorAll(".ft-point").forEach((n) => n.classList.remove("ft-point"));
		node.classList.add("ft-point");
		node.scrollIntoView({ block: "nearest" });
		node.querySelector(".msg-rewind")?.focus();
		pointTimer = setTimeout(() => node.classList.remove("ft-point"), 10000);
		say("The Rewind button of your message is highlighted.");
	}

	// --- events ---------------------------------------------------------------------------------
	function apply(ev) {
		const before = FirstTask.stepOf(state);
		state = FirstTask.reduce(state, ev);
		const now = FirstTask.stepOf(state);
		if (now !== before) {
			document.querySelectorAll(".ft-point").forEach((n) => n.classList.remove("ft-point"));
			say(now === 4 ? FirstTask.DONE_TEXT : `Step ${before} done. Step ${now} of 3: ${FirstTask.STEPS[now - 1].title}.`);
			if (now === 4) completed();
		} else if (FirstTask.view(state).failed && ev.type === "record") say(FirstTask.RETRY_HINT);
		// Step 2 needs the changed paths as a turn begins and after it ends: take them now (the Changes list refreshes too).
		if (ev.type === "record" && FirstTask.stepOf(state) === 2 && ev.chatId === state.chatId) {
			if (ev.record?.type === "agent_start") snapshot(state.chatId, true);
			if (ev.record?.type === "agent_end") {
				snapshot(state.chatId, false);
				refreshChangesSoon();
			}
		}
		if (before === 1 && now === 2) snapshot(state.chatId, true);
		render();
	}
	// Pi's records, from the same channel the chat reads (the self-test feeds recorded ones through this same function).
	const onRecord = (chatId, record) => {
		if (state.phase === "step1" || state.phase === "step2") apply({ type: "record", chatId, record });
	};
	crust.pi.onRecord(({ chatId, record }) => onRecord(chatId, record));
	onCrust("changes:loaded", (_count, chatId, paths) => snapshot(chatId, false, paths));
	onCrust("rewind:restored", (chat, { files, paths }) => apply({ type: "restore", chatId: chat.id, files, paths }));

	async function completed() {
		await save("firstTaskDoneAt");
		// Next: the same loop with the Viewer, only when something answers on the dev address (nothing is started for you).
		try {
			const r = await crust.health.check({ devServer: true });
			if (r.facts?.devServer?.up) toast("Next: see a change in the Viewer.", "info", { label: "Open the Viewer", onClick: () => switchTab("browser") });
		} catch {}
	}

	// --- show, hide, start ---------------------------------------------------------------------
	function start() {
		hidden = false;
		shown = true;
		state = FirstTask.reduce(FirstTask.initial(), { type: "start", chatId: active?.id });
		snapshot(state.chatId, true);
		save("firstTaskHiddenAt", true);
		render();
		card.querySelector(".ft-act .btn")?.focus();
		say("First task. Step 1 of 3: Ask Pi about your project.");
	}
	// The ways back in: the view's link, the palette, the Help menu.
	function show() {
		hidden = false;
		save("firstTaskHiddenAt", true);
		if (state.phase === "idle" || state.phase === "done") {
			state = FirstTask.reduce(FirstTask.initial(), { type: "start", chatId: active?.id });
			snapshot(state.chatId, true);
		}
		shown = true;
		render();
		card.querySelector(".ft-act .btn")?.focus();
	}
	function hideCard() {
		hidden = true;
		shown = false;
		save("firstTaskHiddenAt");
		render();
		$("#input")?.focus();
	}
	function finish() {
		shown = false;
		state = FirstTask.initial();
		render();
		$("#input")?.focus();
	}
	// Later launches: the user pressed Start before and neither finished nor hid it.
	function restore(onb) {
		hidden = !!onb?.firstTaskHiddenAt;
		if (onb?.doneAt && !onb.firstTaskDoneAt && !hidden && state.phase === "idle") {
			state = FirstTask.reduce(FirstTask.initial(), { type: "start", chatId: active?.id });
			snapshot(state.chatId, true);
			shown = true;
			render();
		}
	}

	window.crustFirstTask = {
		start,
		show,
		hide: hideCard,
		restore,
		hidden: () => hidden,
		visible: () => !card.hidden,
		state: () => state,
		onRecord,
		apply,
		_setSource: (fn) => (source = fn || defaultSource),
	};

	// --- selftest ---------------------------------------------------------------------------------
	// Fake events through the real handlers (onRecord, the changes:loaded and rewind:restored hooks): proves the card, not Pi.
	// Nothing is sent to Pi: the self-test runs with PI_CRUST_SELFTEST_NOPROMPT=1, and every check that a message was NOT sent looks
	// at the chat.
	selftestSteps.push(async ({ snap, wait }) => {
		try {
			await crust.health.stubSet({});
		} catch {
			return console.error("SELFTEST first-task: needs PI_CRUST_HEALTH_STUB={} in the environment -> MISMATCH");
		}
		const was = themeSetting();
		const shots = [];
		const t = (name, ok, extra = "") => console.error(`SELFTEST first-task ${name}${extra ? ` ${extra}` : ""} -> ${ok ? "OK" : "MISMATCH"}`);
		const shot = async (name) => {
			for (const theme of ["dark", "light"]) {
				setTheme(theme);
				await wait(450);
				shots.push(`${name}|${theme}|${await snap(`ft-${name}-${theme}`)}`);
			}
		};
		const waitFor = async (fn, ms = 4000) => {
			for (let n = 0; n < ms && !fn(); n += 50) await wait(50);
		};
		const marks = () => [...card.querySelectorAll(".ft-step")].map((li) => li.className.replace("ft-step ", "") + ":" + li.querySelector(".mark").textContent);
		const msgs = () => active.el.querySelectorAll(".msg.user").length;
		const rec = (record) => onRecord(active.id, record);
		const asst = (text, extra = {}) => ({ type: "message_end", message: { role: "assistant", content: text ? [{ type: "text", text }] : [], stopReason: "stop", timestamp: 1, ...extra } });
		await crust.health.onboardingSet("firstTaskDoneAt", null);
		await crust.health.onboardingSet("firstTaskHiddenAt", null);
		await crust.health.onboardingSet("doneAt");
		const sent0 = msgs();
		t("no stray toast", !$("#toasts").childElementCount, `toasts="${$("#toasts").textContent}"`);
		$("#input").value = "";
		finish();
		switchTab("browser");

		// start: three steps, the first one current, the card sits above the message box
		start();
		await wait(200);
		const composerTop = $("#composer").getBoundingClientRect().top;
		const cardBox = card.getBoundingClientRect();
		t("card", !card.hidden && cardBox.bottom <= composerTop && card.querySelectorAll(".ft-step").length === 3 && JSON.stringify(marks()) === JSON.stringify(["now:●", "later:○", "later:○"]) && card.getAttribute("role") === "region" && document.activeElement?.closest("#first-task"), `marks=${marks()} bottom=${Math.round(cardBox.bottom)} composer.top=${Math.round(composerTop)}`);

		// step 1 button: the text goes in the box, nothing is sent
		card.querySelector(".ft-act .btn").click();
		await wait(200);
		t("step 1 text", $("#input").value === FirstTask.STEPS[0].prompt && document.activeElement === $("#input") && msgs() === sent0 && !active.state.streaming, `input="${$("#input").value}" messages=${msgs() - sent0}`);
		// a draft is not replaced without asking
		$("#input").value = "my own draft";
		card.querySelector(".ft-act .btn").click();
		await waitFor(() => dialogOpen);
		t("draft asks first", dialogOpen && $("#modal h2").textContent === "Replace the draft?" && $("#input").value === "my own draft");
		$("#modal .modal-actions .secondary").click();
		await wait(200);
		t("draft kept", $("#input").value === "my own draft" && !dialogOpen);
		$("#input").value = "";
		card.querySelector(".ft-act .btn").click();
		await wait(200);
		await shot("1-ask");

		// Pi's records: the reply alone does not tick, agent_end does
		rec({ type: "agent_start" });
		rec(asst("…"));
		await wait(100);
		t("no tick before agent_end", FirstTask.stepOf(state) === 1 && marks()[0] === "now:●", `marks=${marks()}`);
		rec({ type: "agent_end", messages: [] });
		await wait(150);
		t("step 1 done", FirstTask.stepOf(state) === 2 && JSON.stringify(marks()) === JSON.stringify(["done:✓", "now:●", "later:○"]) && /README\.md/.test(card.textContent) && /Your other changes stay as they are/.test(card.textContent), `marks=${marks()}`);
		$("#input").value = "";
		card.querySelector(".ft-act .btn").click();
		await wait(200);
		t("step 2 text", $("#input").value === FirstTask.STEPS[1].prompt && msgs() === sent0, `input="${$("#input").value.slice(0, 40)}…"`);
		await shot("2-change");

		// the changed paths come from a replaceable source (the real one asks git and stats README.md; a test never depends on this repo's state)
		let list = { paths: ["notes.txt"], readme: null };
		window.crustFirstTask._setSource(async () => list);
		// another chat's records never tick this card (it belongs to the chat it started in)
		onRecord("some-other-chat", { type: "agent_start" });
		onRecord("some-other-chat", asst("…"));
		onRecord("some-other-chat", { type: "agent_end", messages: [] });
		await wait(100);
		t("other chat's turn ignored", FirstTask.stepOf(state) === 2 && state.chatId === active.id);
		// a turn that changes some other file: no tick
		rec({ type: "agent_start" });
		await wait(150); // the baseline snapshot of the changed paths
		list = { paths: ["notes.txt", "other.js"], readme: null };
		rec(asst("…"));
		rec({ type: "agent_end", messages: [] });
		await wait(250);
		t("another file changing does not tick step 2", FirstTask.stepOf(state) === 2, `paths=${JSON.stringify(list.paths)}`);
		// a turn that changes README.md itself: the baseline is taken as the turn begins, the paths again after it ends
		rec({ type: "agent_start" });
		await wait(150);
		list = { paths: ["notes.txt", "other.js", "README.md"], readme: 5 };
		rec(asst("…"));
		await wait(100);
		t("no tick before the turn ends", FirstTask.stepOf(state) === 2);
		rec({ type: "agent_end", messages: [] });
		await wait(300);
		t("step 2 done", FirstTask.stepOf(state) === 3 && JSON.stringify(marks()) === JSON.stringify(["done:✓", "done:✓", "now:●"]) && /Rewind/.test(card.textContent) && /Restore the files/.test(card.textContent), `marks=${marks()}`);
		// step 3: the button lights up Rewind on your last message (a stand-in message with the real bar's class names)
		const fake = el("div", "msg user", "my message");
		const bar = el("div", "user-actions");
		const rw = el("button", "icon msg-rewind");
		rw.type = "button";
		bar.append(rw);
		fake.append(bar);
		active.el.append(fake);
		card.querySelector(".ft-act .btn").click();
		await wait(200);
		t("step 3 points at Rewind", fake.classList.contains("ft-point") && document.activeElement === rw && getComputedStyle(bar).opacity === "1");
		await shot("3-undo");
		// a restore of nothing, of another file, then of README.md
		emitCrust("rewind:restored", active, { files: 0, paths: [] });
		await wait(100);
		t("restore of nothing", FirstTask.stepOf(state) === 3);
		emitCrust("rewind:restored", active, { files: 1, paths: ["other.js"] });
		await wait(100);
		t("restore of another file does not tick step 3", FirstTask.stepOf(state) === 3);
		emitCrust("rewind:restored", { id: "some-other-chat" }, { files: 1, paths: ["README.md"] });
		await wait(100);
		t("another chat's rewind does not tick step 3", FirstTask.stepOf(state) === 3);
		emitCrust("rewind:restored", active, { files: 1, paths: ["README.md"] });
		await wait(300);
		const saved = await crust.health.onboarding();
		t("done", FirstTask.stepOf(state) === 4 && card.textContent.includes("You've seen the loop: ask, change, undo. Pi Crust remembers this.") && !!saved.firstTaskDoneAt && !fake.classList.contains("ft-point"), `done text=${card.querySelector(".ft-done")?.textContent} firstTaskDoneAt=${!!saved.firstTaskDoneAt}`);
		fake.remove();
		await shot("4-done");
		card.querySelector(".ft-hide").click();
		t("close after done", card.hidden && FirstTask.stepOf(state) === 0);

		// a failed run: Pi's error stays in the chat, the card offers Try again and puts the text back
		start();
		rec({ type: "agent_start" });
		rec(asst("", { stopReason: "error", errorMessage: "rate limit" }));
		rec({ type: "agent_end", messages: [] });
		await wait(150);
		const retry = card.querySelector(".ft-act .btn");
		t("failed run", FirstTask.stepOf(state) === 1 && retry?.textContent === "Try again" && /That didn't finish/.test(card.textContent), `button="${retry?.textContent}"`);
		await shot("5-failed");
		$("#input").value = "";
		retry.click();
		await wait(200);
		t("try again", $("#input").value === FirstTask.STEPS[0].prompt && card.querySelector(".ft-act .btn").textContent !== "Try again" && msgs() === sent0);

		// hide, remembered; the welcome view's link brings it back
		card.querySelector(".ft-hide").click();
		await wait(200);
		const h = await crust.health.onboarding();
		t("hide", card.hidden && !!h.firstTaskHiddenAt && hidden && document.activeElement === $("#input"), `hiddenAt=${!!h.firstTaskHiddenAt}`);
		await shot("6-dismissed");
		await crust.health.onboardingSet("firstTaskDoneAt", null); // the earlier run finished; this one is a fresh start
		await crust.health.stubSet({ pi: "missing", node: "missing" });
		await window.crustOnboarding.open("test");
		await window.crustOnboarding.refresh({ fresh: true, figma: true });
		const link = $("#ob-first-task");
		t("view offers it", !link.hidden && link.textContent === "Show the first task");
		link.click();
		await wait(300);
		const h2 = await crust.health.onboarding();
		t("view link shows the card", !window.crustOnboarding.isOpen() && !card.hidden && !h2.firstTaskHiddenAt && !hidden);
		// Start in the view: only with everything done, hands over to the card
		await crust.health.stubSet({});
		finish();
		await window.crustOnboarding.open("test");
		await window.crustOnboarding.refresh({ fresh: true, figma: true });
		$("#ob-start").click();
		await wait(400);
		t("Start hands over", !window.crustOnboarding.isOpen() && !card.hidden && FirstTask.stepOf(state) === 1);

		// narrow chat pane: the card keeps its layout
		const pane = $("#chat-pane");
		const w0 = pane.style.width;
		const f0 = pane.style.flex;
		pane.style.flex = "none";
		pane.style.width = "320px";
		await wait(300);
		const nb = card.getBoundingClientRect();
		t("narrow chat", nb.width > 0 && nb.right <= pane.getBoundingClientRect().right + 1 && card.scrollWidth <= card.clientWidth + 1, `card=${Math.round(nb.width)}px pane=${Math.round(pane.getBoundingClientRect().width)}px`);
		await shot("7-narrow");
		pane.style.width = w0;
		pane.style.flex = f0;
		finish();
		await crust.health.onboardingSet("firstTaskDoneAt", null);
		await crust.health.onboardingSet("firstTaskHiddenAt", null);
		await crust.health.onboardingSet("doneAt", null);
		await crust.health.stubSet({});
		window.crustFirstTask._setSource(null);
		setTheme(was);
		console.error(`SELFTEST first-task shots: ${shots.join(" ; ")}`);
	}, "first-task");
})();
