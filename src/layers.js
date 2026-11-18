// Layer check: every overlay sits on a named layer (--layer-* in styles.css) and its controls can be reached.
// Run alone with: npm run selftest -- layers
// RULE: a new overlay takes a --layer-* variable (never a bare z-index) and gets a case in OVERLAYS below.
// Each case opens the overlay with stubbed state (nothing is sent to Pi, nothing is switched), alone and then on top of
// every lower overlay. The test is document.elementFromPoint at the centre of each control: it must return the control
// or a child of it. A higher overlay must never be hidden by a lower one; two overlays that are not blocking
// (menus, popovers, toasts, Pi's question) must not cover each other's controls either. Pi's question is never covered by the
// context panel (it ends above the question). The slash and @ menus may cover it while the user types, until Esc (step 4b).
//
// Not cases: the Figma pill and the Figma panel (#figma-pill, #figma-panel) sit in the page flow of the Design tab, not
// over it, so nothing can cover them. Same-level pairs are skipped on purpose, because they never open together:
// popovers close each other (a click outside closes the open one), and the toast and the update card sit in opposite
// corners (checked below as an explicit pair). Modals that can be open together have distinct levels:
// repo picker (+0) < image preview (+1) < command palette (+2, the shortcut works over both).
//
// Setup (onboarding.js, first-task.js): the welcome view is popover - 1 (a full-screen view: the sign-in panel, the repo picker, the
// palette, toasts and confirms all open over it). The header pill and the first-task card are in the page flow, no layer. What each
// does while the view is open: a question from Pi closes the view (the pill reopens it); the view refuses to open while a question is
// pending; the picker and the palette open over it and stay on top. These cases open the view and the card for real, so they need the
// health stub in the environment (PI_CRUST_HEALTH_STUB={}, as the onboarding step does): nothing is written to settings.json.
"use strict";

selftestSteps.push(async ({ snap, wait }) => {
	const LAYERS = ["base", "panel", "popover", "modal", "toast", "confirm"]; // lowest to highest, same order as styles.css
	const BLOCKING = new Set(["modal", "confirm"]); // these dim and cover what is below on purpose
	const cssLayer = (name) => getComputedStyle(document.documentElement).getPropertyValue(`--layer-${name}`).trim();
	const vis = (n) => n && n.isConnected && !n.hidden && n.getClientRects().length > 0;
	const clicked = (n) => n?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	const typeInto = (text) => {
		$("#input").focus();
		$("#input").value = text;
		$("#input").setSelectionRange(text.length, text.length);
		$("#input").dispatchEvent(new Event("input", { bubbles: true }));
	};
	const menuOf = (cls, btn) => ({
		root: () => $(`.${cls}`),
		open: () => clicked(btn()),
		controls: () => [...$(`.${cls}`).querySelectorAll(".pal-item, [role^=menuitem]")],
		close: () => $(`.${cls}`) && clicked(btn()), // the module keeps its own handle on the menu: close it the way a user does
	});

	// layer: the --layer-* it must use; plus: its offset inside that layer (distinct levels for modals that can co-occur).
	// Pi's question and the approval prompt of the permission modes: both docked in #ask, in the chat pane's flow, no z-index of
	// their own. The approval prompt has a command to approve (the long one is the phone-view worst case) and three answers.
	const LONG_COMMAND = "npm run build -- --mode production " + "--define:FEATURE_FLAG_NUMBER_ONE=enabled ".repeat(40) + "--outdir dist\n" + "x".repeat(700) + "\nnode scripts/cleanup.js --really --everything";
	const askOverlay = (name, spec, extra = {}) => ({
		name,
		layer: "base",
		root: () => $("#ask"),
		open: () => {
			active.asks = [{ spec: { id: `layers-test-${name}`, method: "select", ...spec }, finish() {} }];
			const was = info.selftest;
			info.selftest = false; // renderAsk would answer it by itself after 1.5 s
			renderAsk();
			info.selftest = was;
		},
		controls: () => [...$("#ask").querySelectorAll(".options button, .modal-actions button")],
		close: () => {
			active.asks = [];
			renderAsk();
		},
		...extra,
	});
	const PERM_OPTIONS = ["Allow once", "Allow for this chat", "Deny"];
	const OVERLAYS = [
		askOverlay("ask", { title: "Layers test", message: "Pick one", options: ["One", "Two"] }),
		askOverlay("perm-ask", { title: 'Allow this command?\ngit commit -m "Fix login"\nMode: Ask before commands', options: PERM_OPTIONS }),
		// The long command takes part in the explicit cases only (alone, toasts, slash menu, welcome view), not in the pair matrix.
		askOverlay("perm-ask-long", { title: `Allow this command?\nThis command is ${LONG_COMMAND.length} characters long. Read all of it before you allow it.\n${LONG_COMMAND}\nMode: Ask before commands`, options: PERM_OPTIONS }, { with: [] }),
		// The Claude Agent's setup card (top of the chat) and pause card (end of the conversation): in the chat's flow, no layer of their own.
		{
			name: "claude-setup-card",
			layer: "base",
			with: ["toast", "update-card"],
			root: () => $(".setup-card"),
			open: () => window.claudeSetupUi.testOpen("setup"),
			controls: () => [...$(".setup-card").querySelectorAll("button")],
			close: () => window.claudeSetupUi.testClose("setup"),
		},
		{
			name: "claude-pause-card",
			layer: "base",
			with: ["toast", "update-card"],
			root: () => $(".pause-card"),
			open: () => window.claudeSetupUi.testOpen("pause"),
			controls: () => [...$(".pause-card").querySelectorAll("button")],
			close: () => window.claudeSetupUi.testClose("pause"),
		},
		{
			name: "diff-add",
			layer: "panel",
			root: () => $("#diff-add"),
			open: () => {
				switchTab("changes"); // the pill lives in the Changes tab
				const b = $("#diff-add");
				b.hidden = false;
				b.style.left = "300px";
				b.style.top = "300px";
			},
			controls: () => [$("#diff-add")],
			close: () => {
				const b = $("#diff-add");
				b.hidden = true;
				b.style.left = b.style.top = "";
			},
		},
		{
			name: "slash-menu",
			layer: "popover",
			root: () => $("#slash-menu"),
			open: () => typeInto("/"),
			controls: () => [...$("#slash-menu").querySelectorAll(".pal-item")].slice(0, 3),
			close: () => typeInto(""),
		},
		{
			name: "mention-menu",
			layer: "popover",
			root: () => $(".mention-menu"),
			open: () => typeInto("@"),
			controls: () => [...$(".mention-menu").querySelectorAll(".pal-item")].slice(0, 3),
			close: () => typeInto(""),
		},
		{
			name: "context-panel",
			layer: "popover",
			root: () => $("#ctx-panel"),
			open: () => openContextPanel(),
			controls: () => [...$("#ctx-panel").querySelectorAll("button, input")],
			close: () => closeContextPanel(),
		},
		{ name: "new-chat-menu", layer: "popover", ...menuOf("wt-menu:not(.view-menu):not(.remote-menu)", () => $("#new-chat-menu")) },
		(() => {
			// The phone button is hidden when remote access isn't available (as in a test run): show it for the case.
			const m = menuOf("remote-menu", () => $("#remote-indicator"));
			let wasHidden = false;
			return {
				name: "remote-menu",
				layer: "popover",
				...m,
				open: () => {
					wasHidden = $("#remote-indicator").hidden;
					$("#remote-indicator").hidden = false;
					m.open();
				},
				close: () => {
					m.close();
					$("#remote-indicator").hidden = wasHidden;
				},
			};
		})(),
		{ name: "view-menu", layer: "popover", ...menuOf("view-menu", () => $("#view-btn")) },
		{
			name: "timeline-popover",
			layer: "popover",
			root: () => $(".tl-pop.layers-test"),
			open: () => {
				const p = el("div", "tl-pop layers-test");
				p.style.cssText = "left:120px;top:120px;width:260px;height:120px";
				const b = el("button", "btn", "Open in chat");
				b.type = "button";
				p.append(b);
				document.body.append(p);
			},
			controls: () => [...$(".tl-pop.layers-test").querySelectorAll("button")],
			close: () => $(".tl-pop.layers-test")?.remove(),
		},
		{
			name: "repo-picker",
			layer: "modal",
			plus: 0,
			root: () => $("#repo-picker"),
			open: () => openRepoPicker(),
			controls: () => [$("#picker-filter"), $("#picker-browse"), $("#picker-cancel"), $(".picker-item")].filter(Boolean),
			close: () => closeRepoPicker(),
		},
		{
			name: "image-preview",
			layer: "modal",
			plus: 1,
			root: () => $(".image-preview"),
			open: () => previewImage("data:image/gif;base64,R0lGODlhAQABAAAAACw=", "layers test"),
			controls: () => [$(".image-preview")],
			close: () => clicked($(".image-preview")),
		},
		{
			name: "palette",
			layer: "modal",
			plus: 2,
			root: () => $("#palette-backdrop"),
			open: () => openPalette(),
			controls: () => [$("#palette-input"), $("#palette-results .pal-item")].filter(Boolean),
			close: () => closePalette(),
		},
		{
			name: "welcome-view",
			layer: "popover",
			plus: -1,
			with: ["context-panel", "repo-picker", "palette", "toast", "update-card", "confirm"], // the questions and other popovers: see the cases below; the others live in the inert app: they cannot open over the view
			root: () => $("#onboarding"),
			open: async () => {
				await crust.health.stubSet({});
				await window.crustOnboarding.open("layers");
			},
			controls: () => [...$("#onboarding").querySelectorAll("button:not([disabled]):not([hidden]):not([aria-disabled='true'])")],
			close: () => window.crustOnboarding.close({ restore: false }),
		},
		{
			name: "setup-pill",
			layer: "base", // in the header's flow
			with: ["toast", "update-card"],
			root: () => $("#setup-pill"),
			open: () => {
				const p = $("#setup-pill");
				p.dataset.was = p.hidden ? "hidden" : "shown";
				p.dataset.wasText = p.textContent;
				p.textContent = "Setup: 2 of 4";
				p.hidden = false;
			},
			controls: () => [$("#setup-pill")],
			close: () => {
				const p = $("#setup-pill");
				p.hidden = p.dataset.was === "hidden";
				p.textContent = p.dataset.wasText ?? "";
			},
		},
		{
			name: "first-task",
			layer: "base", // in the chat pane's flow, above the composer
			with: ["toast", "update-card", "ask"],
			root: () => $("#first-task"),
			open: async () => {
				await crust.health.stubSet({});
				window.crustFirstTask.start();
			},
			controls: () => [...$("#first-task").querySelectorAll("button")],
			close: async () => {
				window.crustFirstTask.hide();
				await crust.health.onboardingSet("firstTaskHiddenAt", null);
			},
		},
		{
			name: "toast",
			layer: "toast",
			root: () => $("#toasts"),
			open: () => toast("Layers test notification", "info", { label: "Undo", onClick() {} }),
			controls: () => [...$("#toasts").querySelectorAll(".toast-action")],
			close: () => $("#toasts").replaceChildren(),
		},
		{
			name: "update-card",
			layer: "toast",
			root: () => $("#app-update-host"),
			open: () => {
				const card = el("div", "toast app-update layers-test");
				const b = el("button", "btn", "Update");
				b.type = "button";
				card.append(el("span", "", "Pi Crust update available"), b);
				$("#app-update-host").append(card);
			},
			controls: () => [...$("#app-update-host").querySelectorAll(".layers-test button")],
			close: () => $("#app-update-host")?.querySelector(".layers-test")?.remove(),
		},
		// The rewind dialog (Claude Agent chats show a note about the saved conversation) and the fork dialog (/fork asks where from): dialogs on the confirm layer.
		{
			name: "rewind-dialog",
			layer: "confirm",
			root: () => $("#modal-backdrop"),
			open: () => void window.rewindTestDialog(),
			controls: () => [...$("#modal").querySelectorAll("input, .modal-actions button")],
			close: () => clicked($("#modal .modal-actions .secondary")),
		},
		{
			name: "fork-dialog",
			layer: "confirm",
			root: () => $("#modal-backdrop"),
			open: () => void showDialog({ method: "select", title: "Fork from where? The fork opens in a new tab", options: ["End of the chat: keep everything so far", "1. First message", "2. Second message"] }),
			controls: () => [...$("#modal").querySelectorAll(".options button, .modal-actions button")],
			close: () => clicked($("#modal .modal-actions .secondary")),
		},
		{
			name: "confirm",
			layer: "confirm",
			root: () => $("#modal-backdrop"),
			open: () => void showDialog({ method: "confirm", title: "Layers test", message: "Is this on top?", yesLabel: "Yes", noLabel: "No" }),
			controls: () => [...$("#modal").querySelectorAll(".modal-actions button")],
			close: () => clicked($("#modal .modal-actions button")),
		},
	];
	const byName = (n) => OVERLAYS.find((o) => o.name === n);
	const isAsk = (o) => o.name === "ask" || o.name.startsWith("perm-ask");
	const ASKS = ["ask", "perm-ask", "perm-ask-long"];
	const level = (o) => LAYERS.indexOf(o.layer) * 100 + (o.plus || 0);
	const mayPair = (a, b) => (!a.with || a.with.includes(b.name)) && (!b.with || b.with.includes(a.name));

	// False when a scrolling ancestor clips (x, y) away: that row is scrolled out of view, not covered.
	const clipped = (node, x, y) => {
		for (let p = node.parentElement; p && p !== document.body; p = p.parentElement) {
			const o = getComputedStyle(p);
			if (o.overflowY === "visible" && o.overflowX === "visible") continue;
			const r = p.getBoundingClientRect();
			if (x < r.left || x > r.right || y < r.top || y > r.bottom) return false;
		}
		return true;
	};
	// The controls of one overlay that are fully on screen (a scrolled-off row is not one to hit): can each be reached?
	const reach = (o) => {
		const out = [];
		for (const c of o.controls()) {
			const r = c.getBoundingClientRect();
			if (!r.width || !r.height || r.left < 0 || r.top < 0 || r.right > innerWidth || r.bottom > innerHeight) continue;
			const x = r.left + r.width / 2;
			const y = r.top + r.height / 2;
			if (!clipped(c, x, y)) continue;
			const hit = document.elementFromPoint(x, y);
			out.push({ el: c, ok: !!hit && (hit === c || c.contains(hit)), over: hit ? hit.id || `${hit.tagName.toLowerCase()}.${String(hit.className).split(" ")[0]}` : "none" });
		}
		return out;
	};
	const settle = (o) => wait(["context-panel", "repo-picker", "palette", "mention-menu", "welcome-view"].includes(o.name) ? 600 : 250);
	const shut = async (o) => {
		try {
			o.close();
		} catch (e) {
			console.error(`layers: closing ${o.name} failed`, e);
		}
		await wait(150);
	};
	let bad = 0;
	const report = (what, theme, rows, extra = "") => {
		const fail = rows.filter((r) => !r.ok);
		const ok = rows.length > 0 && !fail.length && !extra;
		if (!ok) bad++;
		const covered = fail.length ? ` covered=${JSON.stringify(fail.map((r) => `${r.el.textContent.trim().slice(0, 14) || r.el.id || r.el.className} under ${r.over}`))}` : "";
		console.error(`SELFTEST layers ${what} (${theme}): controls=${rows.length}${covered}${extra} -> ${ok ? "OK" : "MISMATCH"}`);
	};
	if (!active) return console.error("SELFTEST layers: no active chat -> MISMATCH");
	const streamed = active.state.streaming;
	// Opens `first`, then `second`, and checks them. Normally `second` is the higher overlay. `late` is the other order, for a
	// question that appears while a popover is open: `first` is the popover and `second` the question, still the one on top.
	const together = async (first, second, theme, shot, late = false) => {
		const lo = late ? second : first;
		const hi = late ? first : second;
		const top = late ? second : hi;
		const under = late ? first : lo;
		if (hi.name === "confirm") active.state.streaming = true; // a chat is working, as when repos are switched mid-run
		await first.open();
		await settle(first);
		await second.open();
		await settle(second);
		const topRows = vis(top.root()) ? reach(top) : [];
		// The input's own menus (slash, @) open upward over the question docked above it while the user types (step 4b: Esc closes
		// them and the question is reachable again). The context panel is never allowed over it: it ends above the question.
		const ownMenu = !late && isAsk(lo) && ["slash-menu", "mention-menu"].includes(hi.name);
		// The welcome view is a full-screen view: the sign-in panel (and anything else) opens over part of it on purpose.
		const underRows = (late || !BLOCKING.has(hi.layer)) && !ownMenu && lo.name !== "welcome-view" && vis(under.root()) ? reach(under) : [];
		report(`${first.name} then ${second.name}`, theme, [...topRows, ...underRows], vis(top.root()) ? "" : " top not visible");
		if (shot) await snap(`layers-${first.name}-${second.name}-${theme}`);
		await shut(second);
		await shut(first);
		active.state.streaming = streamed;
	};

	// Raw numbers: any z-index above 5 in a stylesheet must be a var(--layer-*) (or a calc() on one). 1, 2 and 5 are fine
	// inside one component.
	const rawZ = [];
	const walk = (list) => {
		for (const rule of list) {
			if (rule.cssRules) walk(rule.cssRules);
			const z = rule.style?.getPropertyValue?.("z-index")?.trim();
			if (!z) continue;
			const n = Number(z);
			if (!/var\(--layer-[a-z]+\)/.test(z) && !(Number.isFinite(n) && n <= 5)) rawZ.push(`${rule.selectorText}: ${z}`);
		}
	};
	for (const sheet of document.styleSheets) {
		if (/node_modules/.test(sheet.href || "")) continue; // xterm's own CSS: not ours
		try {
			walk(sheet.cssRules);
		} catch {} // a cross-origin sheet: not ours
	}
	// The arrow of the split "New chat" button (agent menu + worktree): on the popover layer, lists Pi and Claude Agent, works by keyboard,
	// closes on Escape (focus back on the arrow) and on a click outside.
	{
		const arrow = $("#new-chat-menu");
		const problems = [];
		const menuEl = () => document.querySelector(".wt-menu:not(.view-menu):not(.remote-menu)");
		arrow.click();
		await wait(250);
		const m = menuEl();
		const labels = m ? [...m.querySelectorAll("[role=menuitem] .label")].map((n) => n.textContent) : [];
		if (labels.slice(0, 2).join() !== "Pi,Claude Agent") problems.push(`items ${labels}`);
		if (m && getComputedStyle(m).zIndex !== cssLayer("popover")) problems.push("not on the popover layer");
		if (arrow.getAttribute("aria-expanded") !== "true") problems.push("aria-expanded not true");
		if (m && document.activeElement !== m.querySelector("[role=menuitem]")) problems.push("first item has no focus");
		window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
		if (m && document.activeElement !== m.querySelectorAll("[role=menuitem]")[1]) problems.push("ArrowDown did not move");
		window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		await wait(150);
		if (menuEl() || document.activeElement !== arrow || arrow.getAttribute("aria-expanded") !== "false") problems.push("Escape did not close it and return focus");
		arrow.click();
		await wait(250);
		document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
		await wait(150);
		if (menuEl()) {
			problems.push("a click outside did not close it");
			arrow.click();
		}
		if (problems.length) bad++;
		console.error(`SELFTEST layers new-chat-menu keyboard, Escape and outside click: ${problems.length ? "MISMATCH " + problems.join("; ") : "OK"}`);
	}
	if (rawZ.length) bad++;
	console.error(`SELFTEST layers raw z-index numbers: ${rawZ.length ? JSON.stringify(rawZ) : "none"} -> ${rawZ.length ? "MISMATCH" : "OK"}`);

	const was = themeSetting();
	const tab = activeTab;
	for (const theme of ["dark", "light"]) {
		setTheme(theme);
		await wait(400);
		// 1. The layer variables exist, and every overlay uses its own.
		for (const name of LAYERS.filter((n) => n !== "base"))
			if (!/^\d+$/.test(cssLayer(name))) {
				bad++;
				console.error(`SELFTEST layers variable --layer-${name} (${theme}): missing -> MISMATCH`);
			}
		for (const o of OVERLAYS) {
			await o.open();
			await settle(o);
			const root = o.root();
			const z = root ? getComputedStyle(root).zIndex : "none";
			const want = o.layer === "base" ? "auto" : String(Number(cssLayer(o.layer)) + (o.plus || 0));
			const extra = !vis(root) ? " not visible" : z !== want ? ` z-index=${z} but ${o.layer}${o.plus ? `+${o.plus}` : ""} is ${want}` : "";
			// 2. Alone: the controls can be reached.
			const rows = vis(root) ? reach(o) : [];
			const hint = vis(root) && !rows.length ? ` (${o.controls().length} controls found, box ${JSON.stringify(root.getBoundingClientRect())})` : "";
			report(`${o.name} alone`, theme, rows, extra + hint);
			await shut(o);
		}
		// 3. On top of each lower overlay: the top one's controls can be reached; non-blocking ones don't cover each other.
		//    Screenshots: the reported case (confirm over the picker), and a toast over the picker and over Pi's question.
		for (const lo of OVERLAYS)
			for (const hi of OVERLAYS) {
				if (level(hi) <= level(lo) || !mayPair(lo, hi)) continue;
				const shot = (hi.name === "context-panel" && ["ask", "perm-ask"].includes(lo.name)) || (hi.name === "confirm" && lo.name === "repo-picker") || (hi.name === "toast" && ["repo-picker", "ask", "perm-ask"].includes(lo.name));
				await together(lo, hi, theme, shot);
			}
		// 4. A question that appears while a popover is open must end up reachable (the input's own menus excepted: Esc closes them).
		for (const lo of OVERLAYS.filter((o) => o.layer === "popover" && !["slash-menu", "mention-menu"].includes(o.name))) for (const q of ASKS) await together(lo, byName(q), theme, false, true);
		// 4b. The slash and @ menus belong to the message box and may cover the answer buttons while the user types. Esc must close
		//     them, and then every answer button is reachable again.
		for (const [menu, qName] of [[byName("slash-menu"), "ask"], [byName("mention-menu"), "ask"], [byName("slash-menu"), "perm-ask"], [byName("slash-menu"), "perm-ask-long"]]) {
			const q = byName(qName);
			await q.open();
			await settle(q);
			await menu.open();
			await settle(menu);
			const shown = vis(menu.root());
			const wasCovered = shown ? reach(q).filter((r) => !r.ok).length : 0;
			$("#input").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
			await wait(250);
			const closed = !vis(menu.root());
			console.error(`SELFTEST layers ${menu.name} over the question while typing (${theme}): menu shown=${shown}, answer controls under it=${wasCovered}`);
			report(`${menu.name} closed by Esc, ${q.name} reachable`, theme, reach(q), shown && closed ? "" : ` menu shown=${shown} closed=${closed}`);
			await shut(menu);
			await shut(q);
		}
		// 4c. The approval prompt (one command, then a very long one) with two toasts: the toast column is above it and covers none of its
		//     answers; every answer is reachable, and so is every toast action.
		for (const qName of ["perm-ask", "perm-ask-long"]) {
			const q = byName(qName);
			await q.open();
			await settle(q);
			toast("Extension error (permission-modes): something went wrong while loading, which is a long enough message to wrap onto several lines", "error", { label: "Details", onClick() {} });
			toast("Pi Crust brings its own permission modes. Your older copy in ~/.pi/agent/extensions loads too. Remove or rename it.", "info", { label: "Undo", onClick() {} });
			await wait(300);
			const tz = Number(getComputedStyle($("#toasts")).zIndex);
			report(`${q.name} with two toasts, answers`, theme, reach(q), "");
			report(`${q.name} with two toasts, toast actions`, theme, reach(byName("toast")), $("#toasts").children.length === 2 && tz > 0 ? "" : ` toasts=${$("#toasts").children.length} z=${tz}`);
			if (qName === "perm-ask") await snap(`layers-perm-ask-two-toasts-${theme}`);
			$("#toasts").replaceChildren();
			await shut(q);
		}
		// 5. Same level, open together: the toast column and the update card.
		await together(byName("toast"), byName("update-card"), theme, false);
		// 6. Setup. The first-task card and Pi's question are both in the chat pane's flow: neither may cover the other.
		await together(byName("first-task"), byName("ask"), theme, true);
		// 6b. A question from Pi (or an approval prompt) while the welcome view is open closes the view and is reachable; and the view
		//     does not open over a question.
		for (const qName of ["ask", "perm-ask", "perm-ask-long"]) {
			const view = byName("welcome-view");
			const q = byName(qName);
			await view.open();
			await settle(view);
			await q.open();
			await settle(q);
			const closed = !vis(view.root()) && !$("#app").inert;
			report(`${q.name} while the welcome view is open`, theme, reach(q), closed ? "" : ` view still open (visible=${vis(view.root())} inert=${$("#app").inert})`);
			await shut(view);
			await view.open(); // a question is still pending: the view must stay closed
			await settle(view);
			const refused = !vis(view.root()) && !$("#app").inert && window.crustOnboarding.isOpen() === false;
			report(`welcome view with ${q.name} pending`, theme, reach(q), refused ? "" : " view opened over the question");
			await shut(view);
			await shut(q);
		}
		// 6d. Opening the welcome view closes every popover of the app (the model panel is the context panel, the slash and @ menus, the
		//     worktree menu), so nothing from the app stays on top of the view. The timeline popover closes through the same
		//     outside-click listener as the worktree menu; its real popover needs recorded screenshots, so it is not opened here.
		for (const pop of [byName("context-panel"), byName("slash-menu"), byName("mention-menu"), byName("new-chat-menu")]) {
			const view = byName("welcome-view");
			await pop.open();
			await wait(400);
			const shown = vis(pop.root());
			await view.open();
			await settle(view);
			const left = vis(pop.root());
			report(`${pop.name} closed when the welcome view opens`, theme, reach(view), shown && !left ? "" : ` popover shown=${shown} still open=${left}`);
			await shut(view);
			await shut(pop);
		}
		// 6c. The picker and the view together, in both orders: the picker is the top one either way.
		{
			const view = byName("welcome-view");
			const picker = byName("repo-picker");
			for (const [first, second] of [[picker, view], [view, picker]]) {
				await first.open();
				await settle(first);
				await second.open();
				await settle(second);
				const pz = Number(getComputedStyle($("#repo-picker")).zIndex);
				const vz = Number(getComputedStyle($("#onboarding")).zIndex);
				report(`${first.name} then ${second.name}: picker on top`, theme, vis($("#repo-picker")) ? reach(picker) : [], pz > vz ? "" : ` picker z=${pz} view z=${vz}`);
				await shut(second);
				await shut(first);
			}
		}
	}
	setTheme(was);
	switchTab(tab);
	console.error(`SELFTEST layers: ${bad ? `${bad} problem(s)` : "all overlays reachable"} -> ${bad ? "MISMATCH" : "OK"}`);
});
