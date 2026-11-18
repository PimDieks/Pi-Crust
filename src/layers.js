// Layer check: every overlay sits on a named layer (--layer-* in styles.css) and its controls can be reached.
// Run alone with: npm run selftest -- layers
// RULE: a new overlay takes a --layer-* variable (never a bare z-index) and gets a case in OVERLAYS below.
// Each case opens the overlay with stubbed state (nothing is sent to Pi, nothing is switched), alone and then on top of
// every lower overlay. The test is document.elementFromPoint at the centre of each control: it must return the control
// or a child of it. A higher overlay must never be hidden by a lower one; two overlays that are not blocking
// (menus, popovers, toasts) must not cover each other's controls either.
"use strict";

selftestSteps.push(async ({ snap, wait }) => {
	const LAYERS = ["panel", "popover", "toast", "modal", "confirm"]; // lowest to highest, same order as styles.css
	const BLOCKING = new Set(["modal", "confirm"]); // these dim and cover what is below on purpose
	const cssLayer = (name) => getComputedStyle(document.documentElement).getPropertyValue(`--layer-${name}`).trim();
	const vis = (n) => n && n.isConnected && !n.hidden && n.getClientRects().length > 0;
	const clicked = (n) => n?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	const fire = (n, type) => n.dispatchEvent(new Event(type, { bubbles: true }));

	const OVERLAYS = [
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
			open: () => {
				$("#input").focus();
				$("#input").value = "/";
				fire($("#input"), "input");
			},
			controls: () => [...$("#slash-menu").querySelectorAll(".pal-item")].slice(0, 3),
			close: () => {
				$("#input").value = "";
				fire($("#input"), "input");
			},
		},
		{
			name: "context-panel",
			layer: "popover",
			root: () => $("#ctx-panel"),
			open: () => openContextPanel(),
			controls: () => [...$("#ctx-panel").querySelectorAll("button, input")],
			close: () => closeContextPanel(),
		},
		{
			name: "worktree-menu",
			layer: "popover",
			root: () => $(".wt-menu"),
			open: () => clicked($("#new-chat-menu")),
			controls: () => [...$(".wt-menu").querySelectorAll(".pal-item")],
			close: () => $(".wt-menu") && clicked($("#new-chat-menu")), // the module keeps its own handle on the menu
		},
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
			name: "image-preview",
			layer: "modal",
			root: () => $(".image-preview"),
			open: () => previewImage("data:image/gif;base64,R0lGODlhAQABAAAAACw=", "layers test"),
			controls: () => [$(".image-preview")],
			close: () => clicked($(".image-preview")),
		},
		{
			name: "repo-picker",
			layer: "modal",
			root: () => $("#repo-picker"),
			open: () => openRepoPicker(),
			controls: () => [$("#picker-filter"), $("#picker-browse"), $("#picker-cancel"), $(".picker-item")].filter(Boolean),
			close: () => closeRepoPicker(),
		},
		{
			name: "palette",
			layer: "modal",
			root: () => $("#palette-backdrop"),
			open: () => openPalette(),
			controls: () => [$("#palette-input"), $("#palette-results .pal-item")].filter(Boolean),
			close: () => closePalette(),
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
	const settle = (o) => wait(["context-panel", "repo-picker", "palette"].includes(o.name) ? 500 : 250);
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

	const was = themeSetting();
	const tab = activeTab;
	const chat = active;
	const streamed = chat?.state.streaming;
	for (const theme of ["dark", "light"]) {
		setTheme(theme);
		await wait(400);
		// 1. The layer variables exist, and every overlay uses its own.
		for (const name of LAYERS)
			if (!/^\d+$/.test(cssLayer(name))) {
				bad++;
				console.error(`SELFTEST layers variable --layer-${name} (${theme}): missing -> MISMATCH`);
			}
		for (const o of OVERLAYS) {
			await o.open();
			await settle(o);
			const root = o.root();
			const z = root ? getComputedStyle(root).zIndex : "none";
			const want = cssLayer(o.layer);
			const extra = !vis(root) ? " not visible" : z !== want ? ` z-index=${z} but --layer-${o.layer}=${want || "unset"}` : "";
			// 2. Alone: the controls can be reached.
			report(`${o.name} alone`, theme, vis(root) ? reach(o) : [], extra);
			await shut(o);
		}
		// 3. On top of each lower overlay: the top one's controls can be reached; non-blocking ones don't cover each other.
		for (const lo of OVERLAYS) {
			for (const hi of OVERLAYS) {
				if (LAYERS.indexOf(hi.layer) <= LAYERS.indexOf(lo.layer)) continue;
				if (chat && hi.name === "confirm") chat.state.streaming = true; // a chat is working, as when repos are switched mid-run
				await lo.open();
				await settle(lo);
				await hi.open();
				await settle(hi);
				const topRows = vis(hi.root()) ? reach(hi) : [];
				const loRows = !BLOCKING.has(hi.layer) && vis(lo.root()) ? reach(lo) : [];
				report(`${lo.name} + ${hi.name}`, theme, [...topRows, ...loRows], vis(hi.root()) ? "" : " top not visible");
				if (hi.name === "confirm" && lo.name === "repo-picker") await snap(`layers-${lo.name}-${hi.name}-${theme}`);
				await shut(hi);
				await shut(lo);
				if (chat) chat.state.streaming = streamed;
			}
		}
	}
	setTheme(was);
	switchTab(tab);
	console.error(`SELFTEST layers: ${bad ? `${bad} problem(s)` : "all overlays reachable"} -> ${bad ? "MISMATCH" : "OK"}`);
});
