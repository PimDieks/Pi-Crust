// The Viewer's tools by the kind of the active tab (page, image, PDF): the rules are src/viewer-kind.js (the second table in section B of the
// Viewer tabs spec). A tool that does not work on this kind is disabled with the reason: aria-disabled (not `disabled`, so it keeps keyboard
// focus), the reason as hover text, as the accessible description and, on hover and focus, as a line inside the tab row (a popup below it
// would sit under the native page view). Also the image tab's two sizes, "Fit" and "100%". Back, forward, reload, DevTools and "open in
// system browser" are not touched.
"use strict";

(() => {
	const VK = window.ViewerKind;
	let kind = "page";
	let zoom = "fit";
	let broken = ""; // "" | "load" | "missing" | "unloaded": the active tab's page did not load (src/viewer-kind.js brokenOf)
	const bound = new Map(); // node -> feature
	const reasonEl = $("#vt-reason");
	const zoomBox = $("#vt-zoom");

	function paint(node, feature) {
		const why = VK.reason(kind, feature, broken);
		const was = node.getAttribute("aria-disabled") === "true";
		if (why) {
			if (!was) node.dataset.title0 = node.title || "";
			node.setAttribute("aria-disabled", "true");
			node.classList.add("is-disabled");
			node.title = why;
			node.dataset.kindReason = why;
			node.setAttribute("aria-description", why);
		} else if (was) {
			node.removeAttribute("aria-disabled");
			node.classList.remove("is-disabled");
			node.title = node.dataset.title0 || "";
			delete node.dataset.kindReason;
			node.removeAttribute("aria-description");
			if (reasonEl.dataset.for === feature) hideReason();
		}
	}
	function showReason(node) {
		if (node.getAttribute("aria-disabled") !== "true") return;
		reasonEl.textContent = node.dataset.kindReason || "";
		reasonEl.dataset.for = bound.get(node) || "";
		reasonEl.classList.add("show");
	}
	function hideReason() {
		reasonEl.classList.remove("show");
		reasonEl.textContent = "";
		reasonEl.dataset.for = "";
	}
	// Links a control to a feature: it follows the kind of the active tab from now on.
	function bind(node, feature) {
		if (!node || bound.has(node)) return node;
		bound.set(node, feature);
		node.addEventListener(
			"click",
			(e) => {
				if (node.getAttribute("aria-disabled") !== "true") return;
				e.preventDefault();
				e.stopImmediatePropagation();
			},
			true,
		);
		node.addEventListener("mouseenter", () => showReason(node));
		node.addEventListener("focus", () => showReason(node));
		node.addEventListener("mouseleave", hideReason);
		node.addEventListener("blur", hideReason);
		paint(node, feature);
		return node;
	}
	function repaint() {
		for (const [node, feature] of bound) {
			if (!node.isConnected) {
				bound.delete(node);
				continue;
			}
			paint(node, feature);
		}
		zoomBox.hidden = kind !== "image";
		for (const b of zoomBox.querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.zoom === zoom));
		if (!VK.can(kind, "state", broken)) {
			// The Force-state row has nothing to act on.
			$("#state-bar").hidden = true;
			$("#state-btn").setAttribute("aria-expanded", "false");
			$("#state-btn").removeAttribute("aria-pressed");
		}
		// The line also carries other owners' text (the address bar's refusal, a notice from main): only a reason this file put there goes.
		const node = [...bound].find(([, f]) => f === reasonEl.dataset.for)?.[0];
		if (node && node.getAttribute("aria-disabled") !== "true") hideReason();
	}

	for (const [id, feature] of [["#pick-element", "pick"], ["#tweak-btn", "tweak"], ["#scheme-btn", "scheme"], ["#state-btn", "state"], ["#annotate-btn", "annotate"]]) bind($(id), feature);
	for (const b of zoomBox.querySelectorAll("button")) {
		b.addEventListener("click", async () => {
			const r = await crust.browser.imageZoom(b.dataset.zoom);
			if (r?.ok) {
				zoom = r.zoom;
				repaint();
			}
		});
	}

	let shown = null;
	crust.browser.onState((s) => {
		const a = Array.isArray(s.tabs) ? s.tabs.find((t) => t.id === s.activeId) : null;
		const k = VK.norm(a && a.kind);
		const z = (a && a.zoom) || "fit";
		const b = VK.brokenOf(a && a.error);
		const switched = !!a && shown !== a.id;
		if (k === kind && z === zoom && b === broken && !switched) return;
		kind = k;
		zoom = z;
		broken = b;
		if (a) shown = a.id;
		repaint();
		window.dispatchEvent(new CustomEvent("viewer:kind", { detail: { kind, tabId: a && a.id } }));
	});

	window.crustViewerKind = {
		kind: () => kind,
		can: (feature) => VK.can(kind, feature, broken),
		reason: (feature) => VK.reason(kind, feature, broken),
		bind,
		reasonText: () => (reasonEl.classList.contains("show") ? reasonEl.textContent : ""),
	};
})();
