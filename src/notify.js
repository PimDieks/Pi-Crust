// Notifications when Pi finishes or asks something while you are elsewhere; Dock badge for unread chats;
// per-turn Copy button on assistant messages. Uses the hook bus from renderer.js.
"use strict";

(() => {
	const KEY = "crust.notifications";
	const enabled = () => localStorage.getItem(KEY) !== "off";
	let focused = true;
	crust.app.isFocused().then((f) => (focused = f));

	const label = (c) => chatLabel(c);

	// The badge counts chats that need you: finished unread, or asking, while the window is not focused.
	function updateBadge() {
		let n = 0;
		if (!focused && enabled()) for (const c of chats.values()) if (c.unread || c.asks.length) n++;
		crust.app.badge(n);
	}

	function openChat(c) {
		crust.app.show();
		if (chats.has(c.id)) activate(c);
	}

	function notify(c, title) {
		if (info.selftest || !enabled()) return;
		crust.app.isFocused().then((isFocused) => {
			focused = isFocused;
			if (!isFocused) {
				c.unread = true;
				try {
					const n = crustNative.notify(title, { body: label(c) });
					if (n) n.onclick = () => openChat(c);
				} catch {}
				crust.app.bounce();
				renderTabs();
				updateBadge();
			} else if (c !== active) {
				toast(`${title}: ${label(c)}`, "info", { label: "Open", onClick: () => activate(c) });
			}
		});
	}

	onCrust("turn:settled", (c, { aborted }) => {
		if (!aborted) notify(c, `${agentLabel(c)} finished`);
	});
	onCrust("ask:added", (c) => notify(c, `${agentLabel(c)} asks`));
	onCrust("chat:activated", updateBadge);
	onCrust("chat:closed", () => setTimeout(updateBadge));
	crust.app.onFocus((f) => {
		focused = f;
		if (f && active) {
			active.unread = false;
			renderTabs();
		}
		updateBadge();
	});

	const prevActions = window.crustPaletteActions;
	window.crustPaletteActions = () => [
		...(prevActions?.() || []),
		{
			label: `Notifications: ${enabled() ? "on" : "off"}`,
			desc: "click to toggle",
			run: () => {
				localStorage.setItem(KEY, enabled() ? "off" : "on");
				updateBadge();
				toast(`Notifications ${enabled() ? "on" : "off"}`);
			},
		},
	];

	// --- Copy on assistant messages ----------------------------------------------------------
	const COPY_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="5.5" y="5.5" width="7" height="7" rx="1.5"/><path d="M10.5 5.5v-1a1.5 1.5 0 0 0-1.5-1.5H4.5A1.5 1.5 0 0 0 3 4.5V9a1.5 1.5 0 0 0 1.5 1.5h1"/></svg>';
	const CHECK_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8.5l3 3 6-7"/></svg>';
	const blocksOf = new WeakMap(); // turn root -> text block elements, in order

	onCrust("assistant:turn", (c, root) => {
		const bar = el("div", "turn-actions");
		const b = el("button", "icon turn-copy");
		b.type = "button";
		b.title = "Copy the answer";
		b.setAttribute("aria-label", "Copy the answer");
		b.innerHTML = COPY_ICON;
		b.addEventListener("click", async () => {
			const live = view === c ? current : c.current;
			const cur = live?.root === root ? live : null;
			const raw = cur ? [...cur.blocks.values()].filter((x) => x.kind === "text").map((x) => x.raw) : root._rawTexts || [];
			try {
				await crust.clipboard.write(raw.join("\n\n").trim());
			} catch (e) {
				return toast(`Couldn't copy: ${e.message}`, "error");
			}
			b.innerHTML = CHECK_ICON;
			setTimeout(() => (b.innerHTML = COPY_ICON), 1200);
		});
		bar.append(b);
		root.append(bar);
		bar.hidden = true;
		root._bar = bar;
	});
	// Only show the bar once the turn has text; keep it last in the turn (after tool cards).
	onCrust("text:final", (c, blockEl, raw) => {
		const root = blockEl.parentElement;
		if (!root?._bar) return;
		(root._rawTexts ||= []);
		blocksOf.set(blockEl, raw);
		root._rawTexts = [...root.querySelectorAll(":scope > .msg.assistant")].map((n) => blocksOf.get(n) ?? n.textContent);
		root._bar.hidden = false;
		root.append(root._bar);
	});
	onCrust("tool:end", (c) => {
		const root = (view === c ? current : c.current)?.root;
		if (root?._bar && !root._bar.hidden) root.append(root._bar);
	});

	selftestSteps.push(async ({ snap, wait }) => {
		const bars = [...(active?.el.querySelectorAll(".turn-actions") || [])].filter((b) => !b.hidden);
		console.error(`SELFTEST turn copy: ${bars.length} visible-able bars -> ${bars.length ? "OK" : "MISMATCH"}`);
		for (const b of bars) b.style.opacity = "1"; // stands in for :hover in the screenshot
		await wait(300);
		await snap("copy-button");
		bars[0]?.querySelector("button")?.click();
		await wait(300);
		for (const b of bars) b.style.opacity = "";
	});
})();
