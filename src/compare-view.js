// A before/after image comparison: slider (clip + range), overlay (opacity range) and side by side.
// createCompare(beforeSrc, afterSrc, { mode, modes, onMode, labels }) -> element (global, used by turn-shots.js, timeline.js and the Design tab).
// `labels` names the two images (default Before / After). A mode may bring its own drawing: { id, label, render({ stage, extras, beforeSrc, afterSrc }) } (e.g. the pixel diff of the Design tab);
// `extras` is a row under the stage for that mode's controls.
"use strict";

const COMPARE_MODES = [
	{ id: "slider", label: "Slider" },
	{ id: "overlay", label: "Overlay" },
	{ id: "side", label: "Side by side" },
];

function createCompare(beforeSrc, afterSrc, { mode = "slider", modes = COMPARE_MODES, onMode, labels = ["Before", "After"] } = {}) {
	const root = el("div", "cmp");
	const tabs = el("div", "cmp-modes");
	tabs.setAttribute("role", "tablist");
	tabs.setAttribute("aria-label", "Compare mode");
	const stage = el("div", "cmp-stage");
	const extras = el("div", "cmp-extras");
	const range = el("input", "cmp-range");
	range.type = "range";
	range.min = "0";
	range.max = "100";
	range.value = "50";
	range.setAttribute("aria-label", "Compare position");
	const tag = (text) => el("span", "cmp-tag", text);
	const img = (src, alt) => {
		const i = el("img");
		i.src = src;
		i.alt = alt;
		i.draggable = false;
		return i;
	};

	const buttons = new Map();
	for (const m of modes) {
		const b = el("button", "", m.label);
		b.type = "button";
		b.setAttribute("role", "tab");
		b.onclick = () => set(m.id);
		buttons.set(m.id, b);
		tabs.append(b);
	}
	tabs.addEventListener("keydown", (e) => {
		const k = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
		if (!k) return;
		e.preventDefault();
		const i = modes.findIndex((m) => m.id === root.dataset.mode);
		const next = modes[(i + k + modes.length) % modes.length];
		set(next.id);
		buttons.get(next.id).focus();
	});

	function set(id) {
		mode = id;
		root.dataset.mode = id;
		for (const [k, b] of buttons) {
			b.setAttribute("aria-selected", String(k === id));
			b.tabIndex = k === id ? 0 : -1;
		}
		draw();
		onMode?.(id);
	}

	function draw() {
		stage.replaceChildren();
		stage.className = `cmp-stage cmp-${mode}`;
		stage.style.aspectRatio = "";
		extras.replaceChildren();
		extras.hidden = true;
		const custom = modes.find((m) => m.id === mode && m.render);
		if (custom) {
			range.hidden = true;
			stage.classList.add("cmp-custom");
			extras.hidden = false;
			custom.render({ stage, extras, beforeSrc, afterSrc });
			return;
		}
		range.hidden = mode === "side";
		if (mode === "side") {
			for (const [src, label] of [[beforeSrc, labels[0]], [afterSrc, labels[1]]]) {
				const f = el("figure", "cmp-fig");
				f.append(img(src, label), tag(label));
				stage.append(f);
			}
			return;
		}
		const before = img(beforeSrc, labels[0]);
		const after = img(afterSrc, labels[1]);
		before.className = "cmp-before";
		after.className = "cmp-after";
		const line = el("span", "cmp-line");
		const tagAfter = tag(labels[1]);
		tagAfter.classList.add("right");
		stage.append(before, after, tag(labels[0]), tagAfter, line);
		before.onload = () => {
			if (before.naturalWidth) stage.style.aspectRatio = `${before.naturalWidth} / ${before.naturalHeight}`;
		};
		range.setAttribute("aria-label", mode === "slider" ? "Divider position" : `${labels[1]} opacity`);
		const apply = () => {
			const v = Number(range.value);
			stage.style.setProperty("--pos", `${v}%`);
			if (mode === "overlay") after.style.opacity = String(v / 100);
		};
		range.oninput = apply;
		apply();
	}

	root.append(tabs, stage, extras, range);
	set(modes.some((m) => m.id === mode) ? mode : modes[0].id);
	return root;
}
