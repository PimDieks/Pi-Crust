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
	const OVERLAYS = [
		{
			name: "ask",
			layer: "base", // Pi's question: docked in the chat pane's flow, no z-index of its own
			root: () => $("#ask"),
			open: () => {
				active.asks = [{ spec: { id: "layers-test", method: "select", title: "Layers test", message: "Pick one", options: ["One", "Two"] }, finish() {} }];
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
		{ name: "worktree-menu", layer: "popover", ...menuOf("wt-menu:not(.view-menu):not(.remote-menu)", () => $("#new-chat-menu")) },
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
	const level = (o) => LAYERS.indexOf(o.layer) * 100 + (o.plus || 0);

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
	const settle = (o) => wait(["context-panel", "repo-picker", "palette", "mention-menu"].includes(o.name) ? 600 : 250);
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
		const ownMenu = !late && lo.name === "ask" && ["slash-menu", "mention-menu"].includes(hi.name);
		const underRows = (late || !BLOCKING.has(hi.layer)) && !ownMenu && vis(under.root()) ? reach(under) : [];
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
				if (level(hi) <= level(lo)) continue;
				const shot = (hi.name === "context-panel" && lo.name === "ask") || (hi.name === "confirm" && lo.name === "repo-picker") || (hi.name === "toast" && ["repo-picker", "ask"].includes(lo.name));
				await together(lo, hi, theme, shot);
			}
		// 4. A question that appears while a popover is open must end up reachable (the input's own menus excepted: Esc closes them).
		for (const lo of OVERLAYS.filter((o) => o.layer === "popover" && !["slash-menu", "mention-menu"].includes(o.name))) await together(lo, byName("ask"), theme, false, true);
		// 4b. The slash and @ menus belong to the message box and may cover the answer buttons while the user types. Esc must close
		//     them, and then every answer button is reachable again.
		for (const menu of [byName("slash-menu"), byName("mention-menu")]) {
			const q = byName("ask");
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
			report(`${menu.name} closed by Esc, question reachable`, theme, reach(q), shown && closed ? "" : ` menu shown=${shown} closed=${closed}`);
			await shut(menu);
			await shut(q);
		}
		// 5. Same level, open together: the toast column and the update card.
		await together(byName("toast"), byName("update-card"), theme, false);
	}
	setTheme(was);
	switchTab(tab);
	console.error(`SELFTEST layers: ${bad ? `${bad} problem(s)` : "all overlays reachable"} -> ${bad ? "MISMATCH" : "OK"}`);
});
