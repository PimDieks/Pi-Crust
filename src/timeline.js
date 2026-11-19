// A strip under the chat tabs with the "after" screenshot of every turn of the active chat (persisted + live).
// Click a thumbnail for the large comparison, the prompt, "Rewind to before this turn" and "Show in chat".
// Uses the hook bus; shots come from turn-shots.js / snap-main.js.
"use strict";

(() => {
	const ICON = (d) => `<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
	const CHEVRON = ICON('<path d="M4.5 6.5L8 10l3.5-3.5"/>');
	const bar = $("#timeline");
	const KEY = "timelineCollapsed";
	let collapsed = localStorage.getItem(KEY) === "1";
	let pop = null;
	let seq = 0;
	let popSeq = 0; // a newer open/close cancels an openPop still waiting for its data

	function closePop() {
		popSeq++;
		if (!pop) return;
		pop.remove();
		pop = null;
		removeEventListener("keydown", onKey, true);
		removeEventListener("pointerdown", onOutside, true);
		bar.querySelector(".tl-item[aria-expanded='true']")?.setAttribute("aria-expanded", "false");
	}
	const onKey = (e) => {
		if (e.key !== "Escape") return;
		e.stopPropagation();
		closePop();
	};
	const onOutside = (e) => {
		if (pop && !pop.contains(e.target) && !e.target.closest?.(".tl-item")) closePop();
	};

	async function render() {
		const my = ++seq;
		const c = active;
		if (!c) return void (bar.hidden = true);
		const file = await crustShots.sessionFileOf(c);
		if (my !== seq) return;
		const list = file ? await crust.snap.list({ sessionFile: file, role: "after" }) : [];
		if (my !== seq) return;
		bar.hidden = !list.length;
		bar.replaceChildren();
		closePop();
		if (!list.length) return;
		const toggle = el("button", "icon tl-toggle");
		toggle.type = "button";
		toggle.title = collapsed ? "Show the timeline" : "Hide the timeline";
		toggle.setAttribute("aria-label", toggle.title);
		toggle.setAttribute("aria-expanded", String(!collapsed));
		toggle.innerHTML = CHEVRON;
		toggle.onclick = () => {
			collapsed = !collapsed;
			localStorage.setItem(KEY, collapsed ? "1" : "0");
			render();
		};
		bar.classList.toggle("collapsed", collapsed);
		const label = el("span", "tl-label", `Screenshots ${list.length}`);
		bar.append(toggle, label);
		if (collapsed) return;
		let shown = list.length;
		// A thumbnail that can't be loaded is dropped rather than shown as an empty box; no thumbnails left, no strip.
		const drop = (b) => {
			if (my !== seq || !b.isConnected) return;
			b.remove();
			label.textContent = `Screenshots ${--shown}`;
			if (!shown) bar.hidden = true;
		};
		list.forEach((after, i) => {
			const b = el("button", "tl-item");
			b.type = "button";
			b.title = after.tags.prompt || `Turn ${i + 1}`;
			b.setAttribute("aria-label", `Turn ${i + 1}: ${after.tags.prompt || "screenshots"}`);
			b.setAttribute("aria-expanded", "false");
			const img = el("img");
			img.alt = "";
			img.draggable = false;
			crustShots.shotSrc(after, true).then((src) => (src ? (img.src = src) : drop(b)));
			img.onerror = () => drop(b);
			b.append(img, el("span", "tl-n", String(i + 1)));
			b.onclick = () => (b.getAttribute("aria-expanded") === "true" ? closePop() : openPop(c, after, i, b));
			bar.append(b);
		});
		bar.lastElementChild?.scrollIntoView({ inline: "end", block: "nearest" });
	}

	async function openPop(c, after, i, anchor) {
		closePop();
		const my = popSeq;
		anchor.setAttribute("aria-expanded", "true");
		const before = (await crust.snap.list({ sessionFile: after.tags.sessionFile, role: "before" })).find((s) => s.id === after.tags.beforeId);
		if (my !== popSeq || c !== active || !anchor.isConnected) return anchor.setAttribute("aria-expanded", "false");
		pop = el("div", "tl-pop");
		pop.setAttribute("role", "dialog");
		pop.setAttribute("aria-label", `Turn ${i + 1} screenshots`);
		const r = $("#chat-pane").getBoundingClientRect();
		const t = bar.getBoundingClientRect();
		Object.assign(pop.style, { left: `${r.left}px`, width: `${r.width}px`, top: `${t.bottom}px`, maxHeight: `${Math.max(200, innerHeight - t.bottom - 16)}px` });
		const head = el("div", "tl-pop-head");
		head.append(el("strong", "", `Turn ${i + 1}`), el("span", "muted", new Date(after.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })));
		pop.append(head);
		if (after.tags.prompt) pop.append(el("p", "tl-prompt", after.tags.prompt));
		const holder = el("div", "tl-compare");
		pop.append(holder);
		const actions = el("div", "tl-actions");
		const mk = (cls, text, fn) => {
			const b = el("button", `btn ${cls}`, text);
			b.type = "button";
			b.onclick = fn;
			return b;
		};
		actions.append(
			mk("secondary", "Show in chat", () => (closePop(), showInChat(c, after))),
			mk("secondary", "Open large", () => (closePop(), before && crustShots.openShotCompare({ before, after, prompt: after.tags.prompt }))),
			mk("", "Rewind to before this turn", () => (closePop(), window.rewindToCheckpoint(c, after.tags.cpId).catch((e) => toast(`Rewind failed: ${e.message}`, "error")))),
		);
		if (!after.tags.cpId) actions.lastElementChild.disabled = true;
		pop.append(actions);
		document.body.append(pop);
		addEventListener("keydown", onKey, true);
		addEventListener("pointerdown", onOutside, true);
		const [a, b] = await Promise.all([before ? crustShots.shotSrc(before, true) : null, crustShots.shotSrc(after, true)]);
		if (my !== popSeq) return;
		if (pop && a && b) holder.append(createCompare(a, b));
		else if (pop) holder.append(b ? Object.assign(el("img", "tl-single"), { src: b, alt: "After" }) : el("div", "muted", "The screenshots are no longer available"));
	}

	async function showInChat(c, after) {
		if (c !== active) return;
		const card = c.el.querySelector(`[data-shot="${after.id}"]`);
		const node = card || (await window.rewindNodeForCheckpoint(c, after.tags.cpId));
		if (!node) return toast("That turn is no longer in this chat", "warning");
		node.scrollIntoView({ behavior: "smooth", block: "center" });
		node.classList.add("crust-flash");
		setTimeout(() => node.classList.remove("crust-flash"), 1400);
	}

	onCrust("chat:activated", render);
	onCrust("models:loaded", (c) => c === active && render());
	onCrust("shot:added", (c) => c === active && render());
	onCrust("chat:closed", () => render());
	onCrust("chat:cleared", closePop);
	addEventListener("resize", closePop);
	window.refreshTimeline = render;

	// --- selftest -------------------------------------------------------------------------------
	// Fake turn with two generated pages: checks capture of a URL, of the hidden browser view, the card, the timeline.
	selftestSteps.push(async ({ snap, wait }) => {
		const page = (bg, label) => `<body style="margin:0;font:700 40px sans-serif;background:${bg};color:#fff;display:grid;place-items:center;height:100vh">${label}</body>`;
		const dataUrl = (h) => `data:text/html;charset=utf-8,${encodeURIComponent(h)}`;
		const u = await crust.snap.url(dataUrl(page("#2a6", "Before")), { width: 640, height: 400 });
		const u2 = await crust.snap.url(dataUrl(page("#c43", "After")), { width: 640, height: 400, colorScheme: "dark" });
		console.error(`SELFTEST snap:url: ${u.ok ? `${u.entry.w}x${u.entry.h}` : u.error} -> ${u.ok && u.entry.w === 640 && u2.ok ? "OK" : "MISMATCH"}`);
		// The dev browser view while its tab is hidden (the Viewer tab is not the active one).
		// Chromium draws a native view only once it has been shown: a Viewer view that was never on screen has no frame to capture (empty
		// image, see snap-main.js captureLive). So show the Viewer first, as a person would have, then hide it and capture.
		// First: the Viewer has never been shown (in a run of this step alone), the case of a person who never opened the Viewer tab.
		await crust.snap.selftestLoad(page("#36c", "Live"));
		const stNever = await crust.selftest.bounds();
		const drawsBefore = await crust.snap.selftestDraws();
		const never = await crust.snap.live({});
		const stAfter = await crust.selftest.bounds();
		const drawn = (await crust.snap.selftestDraws()) - drawsBefore;
		const sameBounds = JSON.stringify(stNever.view) === JSON.stringify(stAfter.view);
		console.error(`SELFTEST snap:live never shown: view visible=${stNever.visible}->${stAfter.visible} bounds same=${sameBounds} offscreen draws=${drawn} ${never.ok ? `${never.entry.w}x${never.entry.h}` : never.error} -> ${!stNever.visible && !stAfter.visible && sameBounds && drawn === 1 && never.ok && never.entry.w > 100 ? "OK" : "MISMATCH"}`);
		switchTab("browser");
		await wait(800);
		await crust.snap.selftestLoad(page("#36c", "Live"));
		switchTab("changes");
		await wait(600);
		const st = await crust.selftest.bounds();
		const live = await crust.snap.live({});
		console.error(`SELFTEST snap:live hidden: view visible=${st.visible} reasons=${st.hidden} ${live.ok ? `${live.entry.w}x${live.entry.h}` : live.error} -> ${!st.visible && live.ok && live.entry.w > 100 ? "OK" : "MISMATCH"}`);
		switchTab("browser");
		await wait(600);
		const st2 = await crust.selftest.bounds();
		console.error(`SELFTEST browser view shown again: visible=${st2.visible} ${JSON.stringify(st2.view)} -> ${st2.visible && st2.view.width > 100 ? "OK" : "MISMATCH"}`);
		if (!u.ok || !u2.ok) return;

		const file = await crustShots.sessionFileOf(active);
		const base = { sessionFile: file, cpId: null, prompt: "Make the header red and add a pricing section" };
		await crust.snap.tag(u.entry.id, { ...base, role: "before" });
		const after = await crust.snap.tag(u2.entry.id, { ...base, role: "after", beforeId: u.entry.id });
		const pair = { before: u.entry, after, prompt: base.prompt, cpId: null };
		crustShots.addShotCard(active, pair);
		emitCrust("shot:added", active, pair);
		await wait(1200);
		const card = active.el.querySelector(".shot-card");
		card?.scrollIntoView({ block: "center" });
		await wait(300);
		await snap("shot-card");
		const tl = $("#timeline");
		console.error(`SELFTEST timeline: ${tl.hidden ? "hidden" : tl.querySelectorAll(".tl-item").length + " items"}, card=${!!card} -> ${!tl.hidden && tl.querySelector(".tl-item") && card ? "OK" : "MISMATCH"}`);
		await snap("timeline");
		tl.querySelector(".tl-item:last-child")?.click();
		await wait(1000);
		await snap("timeline-pop");
		const popOk = !!document.querySelector(".tl-pop .cmp-stage");
		console.error(`SELFTEST timeline popover: ${popOk ? "compare shown" : "missing"} -> ${popOk ? "OK" : "MISMATCH"}`);
		const was = themeSetting();
		setTheme(currentTheme() === "dark" ? "light" : "dark");
		await wait(500);
		await snap(`timeline-pop-${currentTheme()}`);
		setTheme(was);
		await wait(300);
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		closePop();
		const big = crustShots.openShotCompare(pair);
		await wait(1000);
		for (const m of ["overlay", "side"]) {
			[...document.querySelectorAll("#modal .cmp-modes button")].find((b) => b.textContent.toLowerCase().startsWith(m.slice(0, 4)))?.click();
			await wait(300);
			await snap(`compare-${m}`);
		}
		const st3 = await crust.selftest.bounds();
		console.error(`SELFTEST modal hides browser view: visible=${st3.visible} reasons=${st3.hidden} -> ${!st3.visible && st3.hidden.includes("dialog") ? "OK" : "MISMATCH"}`);
		$("#modal .modal-actions .secondary")?.click();
		await big;
		await wait(400);
		const st4 = await crust.selftest.bounds();
		console.error(`SELFTEST modal closed: visible=${st4.visible} -> ${st4.visible ? "OK" : "MISMATCH"}`);
	});
})();
