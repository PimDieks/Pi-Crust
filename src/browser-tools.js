// Browser bar tools, UI side: the colour-scheme button (Auto → Light → Dark, dev browser only) and the
// "State" row that forces :hover, :focus, :focus-visible, :active and disabled on the last picked element.
// The CDP work happens in browser-tools-main.js.
"use strict";

(() => {
	const ICON = (d) => `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
	const SCHEMES = {
		auto: { label: "Auto (follows the app)", icon: ICON('<circle cx="8" cy="8" r="5.5"/><path d="M8 2.5v11"/>') },
		light: { label: "Light", icon: ICON('<circle cx="8" cy="8" r="2.5"/><path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1"/>') },
		dark: { label: "Dark", icon: ICON('<path d="M13 9.5A5.5 5.5 0 0 1 6.5 3a5.5 5.5 0 1 0 6.5 6.5z"/>') },
	};
	const ORDER = ["auto", "light", "dark"];
	let scheme = "auto";

	const btn = $("#scheme-btn");
	function paintScheme() {
		const s = SCHEMES[scheme];
		btn.innerHTML = s.icon;
		btn.title = `Colour scheme: ${s.label}. Click for ${SCHEMES[ORDER[(ORDER.indexOf(scheme) + 1) % 3]].label.split(" ")[0]}`;
		btn.setAttribute("aria-label", `Colour scheme: ${s.label}`);
		if (scheme === "auto") btn.removeAttribute("aria-pressed");
		else btn.setAttribute("aria-pressed", "true");
	}
	async function cycleScheme() {
		const next = ORDER[(ORDER.indexOf(scheme) + 1) % 3];
		scheme = (await crust.browser.scheme(next)) || next;
		paintScheme();
		toast(`Viewer colour scheme: ${SCHEMES[scheme].label}`, "info");
	}
	btn.addEventListener("click", cycleScheme);
	paintScheme();
	crust.browser.scheme().then((s) => {
		scheme = s || "auto";
		paintScheme();
	});

	// Forced element states
	const bar = $("#state-bar");
	const toggle = $("#state-btn");
	const PSEUDO = [":hover", ":focus", ":focus-visible", ":active"];
	let target = null;
	const boxes = [];
	const what = el("span", "sb-path");
	const clear = el("button", "btn", "Clear");
	clear.type = "button";
	for (const [id, label] of [...PSEUDO.map((p) => [p.slice(1), p]), ["disabled", "disabled"]]) {
		const lab = el("label", "sb-check");
		const cb = document.createElement("input");
		cb.type = "checkbox";
		cb.dataset.state = id;
		cb.addEventListener("change", push);
		lab.append(cb, document.createTextNode(label));
		boxes.push(cb);
		bar.append(lab);
	}
	bar.append(clear, what);

	function paintTarget() {
		for (const cb of boxes) {
			cb.disabled = !target;
			if (!target) cb.checked = false;
		}
		clear.disabled = !target;
		what.textContent = target || "Pick or tweak an element first";
		what.title = target || "";
	}
	async function push() {
		const r = await crust.browser.forceState({
			pseudo: boxes.filter((b) => b.checked && b.dataset.state !== "disabled").map((b) => b.dataset.state),
			disabled: boxes.find((b) => b.dataset.state === "disabled").checked,
		});
		if (r?.error) toast(r.error, "error");
		else if (r?.element) what.textContent = `${target}  →  ${r.element}`;
	}
	clear.addEventListener("click", () => {
		for (const cb of boxes) cb.checked = false;
		push();
	});
	toggle.addEventListener("click", () => {
		bar.hidden = !bar.hidden;
		toggle.setAttribute("aria-expanded", String(!bar.hidden));
		if (bar.hidden) toggle.removeAttribute("aria-pressed");
		else toggle.setAttribute("aria-pressed", "true");
	});
	// A new pick (or a navigation) changes the target; the main process has already dropped the old forced states.
	crust.browser.onTarget((t) => {
		target = t?.selector || null;
		for (const cb of boxes) cb.checked = false;
		paintTarget();
	});
	crust.browser.target().then((t) => {
		target = t?.selector || null;
		paintTarget();
	});
	paintTarget();

	window.crustBrowserTools = { cycleScheme };
})();
