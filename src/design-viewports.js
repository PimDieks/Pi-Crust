// Design tab, "Viewports" view: your page at mobile, tablet and desktop sizes, in light and/or dark, as a grid of
// snapshots (not live). Captured two at a time in offscreen windows via snap:url; refreshed when files change.
"use strict";

(() => {
	const D = window.crustDesign;
	const PRESETS = [
		{ id: "mobile", label: "Mobile", w: 390, h: 844, mobile: true },
		{ id: "tablet", label: "Tablet", w: 820, h: 1180, mobile: false },
		{ id: "desktop", label: "Desktop", w: 1440, h: 900, mobile: false },
	];
	const SCHEMES = [
		{ id: "light", label: "Light" },
		{ id: "dark", label: "Dark" },
		{ id: "both", label: "Both" },
	];
	const LIMIT = 2;
	const load = (k, d) => {
		try {
			return JSON.parse(localStorage.getItem(k)) ?? d;
		} catch {
			return d;
		}
	};
	const state = { presets: new Set(load("vpPresets", ["mobile", "desktop"])), scheme: localStorage.getItem("vpScheme") || "both" };
	let ui = null;
	let visible = false;
	let gen = 0; // bumped on every refresh: results of older runs are dropped
	let tiles = [];
	let running = 0;
	const queue = [];
	let timer = 0;

	const urlNow = () => {
		const v = ui.url.value.trim();
		return /^https?:\/\//i.test(v) || /^data:text\/html/i.test(v) ? v : "";
	};
	const schemes = () => (state.scheme === "both" ? ["light", "dark"] : [state.scheme]);

	function pump() {
		while (running < LIMIT && queue.length) {
			running++;
			queue.shift()().finally(() => {
				running--;
				pump();
			});
		}
	}

	function makeTile(preset, scheme) {
		const tile = el("button", "vp-tile");
		tile.type = "button";
		const head = el("span", "vp-head");
		head.append(el("span", "vp-name", preset.label), el("span", "vp-size", `${preset.w}×${preset.h}`), el("span", "vp-scheme", scheme === "dark" ? "Dark" : "Light"));
		const body = el("span", "vp-body");
		body.append(D.spinner());
		tile.append(head, body);
		const t = { preset, scheme, tile, body, entry: null, thumb: null };
		tile.onclick = () => open(t);
		tile.setAttribute("aria-label", `${preset.label} ${preset.w} by ${preset.h}, ${scheme}`);
		return t;
	}

	async function capture(t, url, my) {
		try {
			const r = await crust.snap.url(url, { width: t.preset.w, height: t.preset.h, colorScheme: t.scheme, mobile: t.preset.mobile, settleMs: 900, kind: "design" });
			if (my !== gen) return;
			if (!r.ok) throw new Error(r.error || "Capture failed");
			t.entry = r.entry;
			t.thumb = await crust.snap.get(r.entry.id, true);
			if (my !== gen) return;
			const img = el("img");
			img.alt = "";
			img.src = t.thumb;
			t.body.replaceChildren(img);
			t.tile.classList.remove("failed");
		} catch (e) {
			if (my !== gen) return;
			t.tile.classList.add("failed");
			t.body.replaceChildren(el("span", "vp-err", String(e.message || e)));
		}
	}

	function refresh() {
		if (!ui) return;
		const url = urlNow();
		const my = ++gen;
		queue.length = 0;
		tiles = [];
		ui.grid.replaceChildren();
		if (!url) {
			ui.grid.append(D.empty("Enter the address of your running app (http or https), or open it in the Viewer tab first."));
			return;
		}
		localStorage.setItem("vpUrl", url);
		const list = PRESETS.filter((p) => state.presets.has(p.id));
		if (!list.length) return void ui.grid.append(D.empty("Pick at least one size."));
		for (const p of list) {
			for (const s of schemes()) {
				const t = makeTile(p, s);
				tiles.push(t);
				ui.grid.append(t.tile);
				queue.push(() => capture(t, url, my));
			}
		}
		pump();
	}

	async function open(t) {
		if (!t.entry) return;
		const src = await crust.snap.get(t.entry.id);
		if (!src) return toast("The screenshot is no longer available", "error");
		D.openImage({
			title: `${t.preset.label} ${t.preset.w}×${t.preset.h}, ${t.scheme}`,
			src,
			onSend: () => D.sendToChat([D.dataUrlToFile(src, `${t.preset.id}-${t.scheme}.png`)], `Screenshot of ${urlNow()} at ${t.preset.w}×${t.preset.h}${t.preset.mobile ? " (mobile)" : ""} in ${t.scheme} mode.`),
		});
	}

	function mount(host) {
		const bar = el("div", "dv-toolbar");
		const sizes = el("div", "seg");
		sizes.setAttribute("role", "group");
		sizes.setAttribute("aria-label", "Sizes");
		for (const p of PRESETS) {
			const b = el("button", "seg-btn", p.label);
			b.type = "button";
			b.title = `${p.w}×${p.h}${p.mobile ? ", mobile emulation" : ""}`;
			b.setAttribute("aria-pressed", String(state.presets.has(p.id)));
			b.onclick = () => {
				if (state.presets.has(p.id)) state.presets.delete(p.id);
				else state.presets.add(p.id);
				b.setAttribute("aria-pressed", String(state.presets.has(p.id)));
				localStorage.setItem("vpPresets", JSON.stringify([...state.presets]));
				refresh();
			};
			sizes.append(b);
		}
		const scheme = el("div", "seg");
		scheme.setAttribute("role", "group");
		scheme.setAttribute("aria-label", "Colour scheme");
		for (const s of SCHEMES) {
			const b = el("button", "seg-btn", s.label);
			b.type = "button";
			b.setAttribute("aria-pressed", String(state.scheme === s.id));
			b.onclick = () => {
				state.scheme = s.id;
				localStorage.setItem("vpScheme", s.id);
				for (const x of scheme.children) x.setAttribute("aria-pressed", String(x === b));
				refresh();
			};
			scheme.append(b);
		}
		const form = el("form", "dv-url-form");
		const url = el("input", "dv-url");
		url.spellcheck = false;
		url.placeholder = "https://localhost:3000/";
		url.setAttribute("aria-label", "Page address");
		url.value = localStorage.getItem("vpUrl") || "";
		form.append(url);
		form.onsubmit = (e) => {
			e.preventDefault();
			refresh();
		};
		const reload = el("button", "icon");
		reload.type = "button";
		reload.title = "Refresh";
		reload.setAttribute("aria-label", "Refresh");
		reload.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9"/><path d="M13.5 2.5v3h-3"/></svg>';
		reload.onclick = refresh;
		bar.append(sizes, scheme, form, reload);
		const grid = el("div", "vp-grid dv-stage");
		host.append(bar, grid);
		ui = { url, grid };
		grid.append(D.empty("Choose sizes and press Enter to capture."));
	}

	function show() {
		visible = true;
		const browserUrl = liveBrowserUrl;
		// Follow the page open in the Viewer tab; the saved address is only a fallback (it may point at a server that's gone).
		if (/^https?:\/\//i.test(browserUrl) && browserUrl !== ui.url.value) {
			ui.url.value = browserUrl;
			return refresh();
		}
		if (!tiles.length) refresh();
	}

	crust.fs.onChanged(() => {
		if (!visible || !tiles.length) return;
		clearTimeout(timer);
		timer = setTimeout(() => visible && refresh(), 1500);
	});

	registerDesignView({
		id: "viewports",
		label: "Viewports",
		mount,
		show,
		hide: () => {
			visible = false;
		},
	});

	D.viewports = { refresh, tiles: () => tiles, setUrl: (u) => ui && (ui.url.value = u), done: () => !running && !queue.length };

	selftestSteps.push(async ({ snap, wait }) => {
		const page = `<style>body{margin:0;font:700 32px sans-serif;display:grid;place-items:center;height:100vh;background:#e8f0ff;color:#123}
			@media (prefers-color-scheme: dark){body{background:#101828;color:#cde}}</style><body>Responsive page</body>`;
		switchTab("design");
		D.select("viewports");
		await wait(300);
		D.viewports.setUrl(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`);
		D.viewports.refresh();
		for (let i = 0; i < 60 && !D.viewports.done(); i++) await wait(500);
		await wait(800);
		const ts = D.viewports.tiles();
		const ok = ts.filter((t) => t.entry && !t.tile.classList.contains("failed"));
		const sizes = ok.map((t) => `${t.entry.w}x${t.entry.h}`).join(",");
		console.error(`SELFTEST viewports: ${ok.length}/${ts.length} tiles, sizes ${sizes} -> ${ts.length === 4 && ok.length === 4 && ok.some((t) => t.entry.w === 390) ? "OK" : "MISMATCH"}`);
		await snap("viewports");
		const was = themeSetting();
		setTheme(currentTheme() === "dark" ? "light" : "dark");
		await wait(500);
		await snap(`viewports-${currentTheme()}`);
		setTheme(was);
		await wait(300);
		ts[0]?.tile.click();
		await wait(800);
		console.error(`SELFTEST viewports large: ${document.querySelector("#modal .dv-large img") ? "image shown" : "missing"} -> ${document.querySelector("#modal .dv-large img") ? "OK" : "MISMATCH"}`);
		await snap("viewports-large");
		$("#modal .modal-actions .secondary")?.click();
		await wait(400);
	});
})();
