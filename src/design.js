// The Design tab (⌘5): a segmented control switches between views registered with registerDesignView
// ({ id, label, mount(host), show?(), hide?() }). Views mount lazily into their own host the first time they are shown.
// Also a few shared helpers for views that work with images (crustDesign.*).
"use strict";

(() => {
	const KEY = "designView";
	const views = [];
	const bar = $("#design-views");
	const host = $("#design-host");
	let current = null;

	function registerDesignView(view) {
		views.push(view);
		const b = el("button", "", view.label);
		b.type = "button";
		b.setAttribute("role", "tab");
		b.dataset.view = view.id;
		b.onclick = () => select(view.id);
		bar.append(b);
		if (!current || localStorage.getItem(KEY) === view.id) current = view.id;
		paint();
	}

	function paint() {
		for (const b of bar.querySelectorAll("button")) {
			const on = b.dataset.view === current;
			b.setAttribute("aria-selected", String(on));
			b.tabIndex = on ? 0 : -1;
		}
	}

	const viewOf = (id) => views.find((v) => v.id === id);

	function select(id) {
		if (!viewOf(id)) return;
		if (id !== current) viewOf(current)?.hide?.();
		current = id;
		localStorage.setItem(KEY, id);
		paint();
		showCurrent();
	}

	function showCurrent() {
		const v = viewOf(current);
		for (const h of host.children) h.hidden = h.dataset.view !== current;
		if (!v) return;
		let h = host.querySelector(`[data-view="${v.id}"]`);
		if (!h) {
			h = el("div", "design-view");
			h.dataset.view = v.id;
			host.append(h);
			try {
				v.mount(h);
			} catch (e) {
				console.error(`design view ${v.id} failed`, e);
			}
		}
		h.hidden = false;
		v.show?.();
	}

	bar.addEventListener("keydown", (e) => {
		const k = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
		if (!k || !views.length) return;
		e.preventDefault();
		const i = views.findIndex((v) => v.id === current);
		const next = views[(i + k + views.length) % views.length];
		select(next.id);
		bar.querySelector(`[data-view="${next.id}"]`).focus();
	});

	onCrust("tab:changed", (name, prev) => {
		if (name === "design") showCurrent();
		else if (prev === "design") viewOf(current)?.hide?.();
	});

	// --- helpers shared by the views -------------------------------------------------------------
	const loadImage = (src) =>
		new Promise((resolve, reject) => {
			const i = new Image();
			i.onload = () => resolve(i);
			i.onerror = () => reject(new Error("Couldn't read the image"));
			i.src = src;
		});

	function dataUrlToFile(url, name) {
		const m = /^data:([^;,]+)(;base64)?,(.*)$/.exec(url);
		const bin = atob(m[3]);
		const bytes = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
		return new File([bytes], name, { type: m[1] });
	}

	// A theme token as an [r, g, b] array, e.g. tokenRgb("--err"). Goes through a canvas pixel, so computed colours of any
	// notation (rgb(), color(srgb …) from color-mix) work.
	const probeCanvas = document.createElement("canvas");
	probeCanvas.width = probeCanvas.height = 1;
	function tokenRgb(token) {
		const probe = el("span");
		probe.style.color = `var(${token})`;
		probe.style.display = "none";
		document.body.append(probe);
		const computed = getComputedStyle(probe).color;
		probe.remove();
		const g = probeCanvas.getContext("2d", { willReadFrequently: true });
		g.clearRect(0, 0, 1, 1);
		g.fillStyle = computed;
		g.fillRect(0, 0, 1, 1);
		const d = g.getImageData(0, 0, 1, 1).data;
		return [d[0], d[1], d[2]];
	}

	// A theme token as a CSS colour string for canvas drawing.
	function tokenColor(token) {
		const [r, g, b] = tokenRgb(token);
		return `rgb(${r}, ${g}, ${b})`;
	}

	// Options for crust.browser.pick: the token-check chips use the status colour pairs of the theme.
	const pickOpts = () => ({
		colors: { okBg: tokenColor("--fills-success-muted"), okText: tokenColor("--text-success"), warnBg: tokenColor("--fills-minor-muted"), warnText: tokenColor("--text-minor") },
	});

	// A short note for views that wait for something: `.dv-empty` is the shared empty state.
	const empty = (text) => el("div", "dv-empty", text);

	// Adds files (and context blocks, as pills) to the open chat and, if given, a note to its input.
	async function sendToChat(files, note, blocks = []) {
		if (!active) return toast("Open a chat first", "warning");
		await addImages(files);
		if (blocks.length) addPicks(blocks);
		if (note) {
			const input = $("#input");
			input.value = input.value ? `${input.value}\n${note}` : note;
			input.dispatchEvent(new Event("input", { bubbles: true }));
		}
		toast("Added to the chat input", "info");
	}

	// A large image in the shared dialog, with an optional extra action (e.g. "Send to chat").
	function openImage({ title, src, sendLabel = "Send to chat", onSend }) {
		const modal = $("#modal");
		const res = showDialog({
			method: "custom",
			title,
			cancelLabel: "Close",
			render(box, finish, actions) {
				modal.classList.add("wide");
				const wrap = el("div", "dv-large");
				const img = el("img");
				img.src = src;
				img.alt = title;
				wrap.append(img);
				box.append(wrap);
				if (onSend) {
					const b = el("button", "btn", sendLabel);
					b.type = "button";
					b.onclick = () => {
						finish({ cancelled: true });
						onSend();
					};
					actions.append(b);
				}
			},
		});
		res.then(() => modal.classList.remove("wide"));
		return res;
	}

	// A small spinner (inline SVG, like the other icons) for tiles that wait for a capture.
	const spinner = () => {
		const s = el("span", "dv-spin");
		s.setAttribute("role", "status");
		s.setAttribute("aria-label", "Loading");
		s.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M13.5 8a5.5 5.5 0 1 1-5.5-5.5"/></svg>';
		return s;
	};

	window.registerDesignView = registerDesignView;
	window.crustDesign = { select, loadImage, dataUrlToFile, tokenRgb, tokenColor, pickOpts, empty, openImage, spinner, sendToChat, views: () => views.map((v) => v.id) };
})();
