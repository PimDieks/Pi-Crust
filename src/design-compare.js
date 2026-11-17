// Design tab, "Compare" view: the selected Figma frame next to a capture of the build, as slider, onion skin, side by side
// or a pixel diff (pixel-diff.js). Both images are brought to the frame's size first.
"use strict";

(() => {
	const D = window.crustDesign;
	const MAX_PIXELS = 4_000_000;
	const DIFF_PIXELS = 1_000_000; // the diff runs on a downscaled copy
	const LETTERBOX = "#808080";
	const state = { fig: null, build: null, diff: null, norm: null };
	let ui = null;
	let seq = 0;

	const MODES = [
		{ id: "slider", label: "Slider" },
		{ id: "overlay", label: "Onion skin" },
		{ id: "side", label: "Side by side" },
		{ id: "diff", label: "Diff", render: renderDiff },
	];
	let mode = localStorage.getItem("designCompareMode") || "slider";

	// --- normalising -----------------------------------------------------------------------------
	// Draws both images on canvases of the frame's size (the build keeps its aspect ratio, aligned top left).
	async function normalise() {
		const [fi, bi] = await Promise.all([D.loadImage(state.fig.dataUrl), D.loadImage(state.build.dataUrl)]);
		let w = state.fig.w || fi.naturalWidth;
		let h = state.fig.h || fi.naturalHeight;
		const k = Math.min(1, Math.sqrt(MAX_PIXELS / (w * h)));
		w = Math.round(w * k);
		h = Math.round(h * k);
		const make = (img, fit) => {
			const c = document.createElement("canvas");
			c.width = w;
			c.height = h;
			const g = c.getContext("2d", { willReadFrequently: true });
			g.fillStyle = LETTERBOX; // the same neutral grey in both themes and for both images, so empty areas never show up as a difference
			g.fillRect(0, 0, w, h);
			if (fit) {
				const s = w / img.naturalWidth;
				g.drawImage(img, 0, 0, w, Math.round(img.naturalHeight * s));
			} else g.drawImage(img, 0, 0, w, h);
			return c;
		};
		const a = make(fi, false);
		const b = make(bi, true);
		return { w, h, a, b, aUrl: a.toDataURL("image/png"), bUrl: b.toDataURL("image/png") };
	}

	// --- diff mode -------------------------------------------------------------------------------
	function renderDiff({ stage, extras }) {
		const { a: a0, b: b0, w: fw, h: fh } = state.norm;
		const k = Math.min(1, Math.sqrt(DIFF_PIXELS / (fw * fh)));
		const w = Math.max(1, Math.round(fw * k));
		const h = Math.max(1, Math.round(fh * k));
		const scaled = (c) => {
			if (k === 1) return c;
			const s = document.createElement("canvas");
			s.width = w;
			s.height = h;
			s.getContext("2d", { willReadFrequently: true }).drawImage(c, 0, 0, w, h);
			return s;
		};
		const a = scaled(a0);
		const b = scaled(b0);
		const canvas = el("canvas", "cmp-diff");
		canvas.width = w;
		canvas.height = h;
		canvas.setAttribute("role", "img");
		stage.style.aspectRatio = `${w} / ${h}`;
		stage.append(canvas);
		const label = el("label", "dv-field");
		const range = el("input");
		range.type = "range";
		range.min = "1";
		range.max = "40";
		range.value = String(Math.round((Number(localStorage.getItem("designDiffThreshold")) || 0.1) * 100));
		range.setAttribute("aria-label", "Difference threshold");
		const tv = el("span", "dv-value");
		label.append("Threshold", range, tv);
		const result = el("span", "dv-result");
		result.setAttribute("aria-live", "polite");
		extras.append(label, result);
		const getData = (c) => c.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, w, h);
		const A = getData(a);
		const B = getData(b);
		let raf = 0;
		const run = () => {
			const threshold = Number(range.value) / 100;
			localStorage.setItem("designDiffThreshold", String(threshold));
			tv.textContent = threshold.toFixed(2);
			const r = PixelDiff.diff(A, B, { threshold });
			// The build stays as it is; each region of differing pixels gets a translucent tint and a thin outline.
			const g = canvas.getContext("2d");
			g.putImageData(B, 0, 0);
			const unit = Math.max(1, Math.min(w, h) / 400); // line widths and padding scale with the downscaled image
			const boxes = PixelDiff.regions(r.mask, w, h, { gap: Math.round(4 * unit), minCount: 2 });
			const [cr, cg, cb] = D.tokenRgb("--err");
			const pad = 3 * unit;
			for (const box of boxes) {
				const x = Math.max(0, box.x0 - pad) + 0.5 * unit;
				const y = Math.max(0, box.y0 - pad) + 0.5 * unit;
				const bw = Math.min(w, box.x1 + pad) - x - 0.5 * unit;
				const bh = Math.min(h, box.y1 + pad) - y - 0.5 * unit;
				g.beginPath();
				g.roundRect(x, y, bw, bh, 2 * unit);
				g.fillStyle = `rgba(${cr}, ${cg}, ${cb}, 0.18)`;
				g.fill();
				g.lineWidth = 1.5 * unit;
				g.strokeStyle = `rgb(${cr}, ${cg}, ${cb})`;
				g.stroke();
			}
			state.diff = { matchPct: r.matchPct, diffCount: r.diffCount, total: r.total, threshold, canvas, regions: boxes.length };
			result.textContent = `${r.matchPct.toFixed(1)} % match, ${r.diffCount.toLocaleString()} of ${r.total.toLocaleString()} px differ${boxes.length ? ` in ${boxes.length} ${boxes.length === 1 ? "area" : "areas"}` : ""}`;
			canvas.setAttribute("aria-label", result.textContent);
		};
		range.oninput = () => {
			// show the value now, run the diff once the slider rests
			tv.textContent = (Number(range.value) / 100).toFixed(2);
			clearTimeout(raf);
			raf = setTimeout(run, 120);
		};
		run();
	}

	// --- view ------------------------------------------------------------------------------------
	function mount(host) {
		const bar = el("div", "dv-toolbar");
		const getFigma = el("button", "btn secondary", "Get Figma selection");
		getFigma.type = "button";
		getFigma.title = "Load the frame selected in Figma desktop";
		const source = el("select");
		source.setAttribute("aria-label", "What to capture of the build");
		for (const [v, t] of [["url", "Page at the frame size"], ["live", "Current viewport"], ["pick", "Picked element"]]) source.append(new Option(t, v));
		source.value = localStorage.getItem("designSource") || "url";
		source.onchange = () => localStorage.setItem("designSource", source.value);
		const capture = el("button", "btn secondary", "Capture build");
		capture.type = "button";
		capture.title = "Capture the Viewer tab's page (the URL in the address bar)";
		const send = el("button", "btn", "Send to chat");
		send.type = "button";
		send.disabled = true;
		bar.append(getFigma, source, capture, el("span", "spacer"), send);
		const meta = el("div", "dv-meta");
		const stage = el("div", "dv-stage");
		host.append(bar, meta, stage);
		ui = { getFigma, capture, send, meta, stage, source };

		getFigma.onclick = async () => {
			getFigma.disabled = true;
			getFigma.setAttribute("aria-busy", "true");
			try {
				const r = await crust.figma.screenshot();
				if (r.error) return toast(r.error, "error");
				await setFigma(r.dataUrl, { w: r.frameW, h: r.frameH, name: r.name });
			} catch (e) {
				toast(`Figma failed: ${e.message || e}`, "error");
			} finally {
				getFigma.disabled = false;
				getFigma.removeAttribute("aria-busy");
			}
		};
		capture.onclick = async () => {
			capture.disabled = true;
			capture.setAttribute("aria-busy", "true");
			try {
				await captureBuild(source.value);
			} catch (e) {
				toast(`Capture failed: ${e.message || e}`, "error");
				if (activeTab !== "design") switchTab("design");
			} finally {
				capture.disabled = false;
				capture.removeAttribute("aria-busy");
			}
		};
		send.onclick = sendToChat;
		render();
	}

	async function setFigma(dataUrl, info) {
		const img = await D.loadImage(dataUrl);
		state.fig = { dataUrl, w: info.w || 0, h: info.h || 0, name: info.name || "Figma frame", nw: img.naturalWidth, nh: img.naturalHeight };
		await render();
	}

	async function setBuild(dataUrl, label) {
		const img = await D.loadImage(dataUrl);
		state.build = { dataUrl, label: label || "Build", nw: img.naturalWidth, nh: img.naturalHeight };
		await render();
	}

	async function captureBuild(kind) {
		const pageUrl = liveBrowserUrl || "";
		let r;
		let label;
		if (kind === "url") {
			if (!/^https?:\/\//i.test(pageUrl)) return toast("Open the page in the Viewer tab first", "warning");
			const w = state.fig?.w || 1280;
			const h = state.fig?.h || 800;
			r = await crust.snap.url(pageUrl, { width: w, height: h, settleMs: 1000, kind: "design" });
			label = `${pageUrl.replace(/^https?:\/\//, "")} at ${w}×${h}`;
		} else if (kind === "live") {
			r = await crust.snap.live({ kind: "design" });
			label = "Viewer viewport";
		} else {
			switchTab("browser");
			await new Promise((res) => setTimeout(res, 150));
			const p = await crust.browser.pick(D.pickOpts());
			switchTab("design");
			if (p.cancelled) return;
			if (p.error) return toast(`Pick failed: ${p.error}`, "error");
			const el0 = p.raw?.[0];
			if (!el0 || el0.rect.width < 1 || el0.rect.height < 1) return toast("That element has no size", "warning");
			r = await crust.snap.live({ rect: { x: Math.round(el0.rect.x), y: Math.round(el0.rect.y), width: Math.round(el0.rect.width), height: Math.round(el0.rect.height) }, kind: "design" });
			label = `${el0.selector.split(" > ").pop()} (${el0.rect.width}×${el0.rect.height})`;
		}
		if (!r.ok) return toast(r.error || "Capture failed", "error");
		await setBuild(await crust.snap.get(r.entry.id), label);
	}

	async function render() {
		if (!ui) return;
		const my = ++seq;
		const { meta, stage, send } = ui;
		const parts = [];
		if (state.fig) parts.push(`Figma: ${state.fig.name}, ${state.fig.w || state.fig.nw}×${state.fig.h || state.fig.nh}`);
		if (state.build) parts.push(`Build: ${state.build.label}, ${state.build.nw}×${state.build.nh}`);
		meta.textContent = parts.join("  |  ");
		meta.hidden = !parts.length;
		send.disabled = !(state.fig && state.build);
		state.norm = null;
		state.diff = null;
		stage.replaceChildren();
		if (!state.fig || !state.build) {
			const one = state.fig || state.build;
			if (one) {
				const i = el("img", "dv-single");
				i.src = one.dataUrl;
				i.alt = state.fig ? "Figma frame" : "Build";
				stage.append(i, D.empty(state.fig ? "Capture the build to compare it with this frame." : "Get the Figma selection to compare it with this capture."));
			} else stage.append(D.empty("Select a frame in Figma desktop and choose Get Figma selection, then capture the build to compare them."));
			return;
		}
		let norm;
		try {
			norm = await normalise();
		} catch (e) {
			return stage.append(D.empty(e.message || String(e)));
		}
		if (my !== seq) return;
		state.norm = norm;
		stage.replaceChildren(
			createCompare(norm.aUrl, norm.bUrl, {
				mode,
				modes: MODES,
				labels: ["Figma", "Build"],
				onMode: (m) => {
					mode = m;
					localStorage.setItem("designCompareMode", m);
				},
			}),
		);
	}

	async function sendToChat() {
		if (!state.norm) return;
		const { aUrl, bUrl } = state.norm;
		const files = [D.dataUrlToFile(aUrl, "figma-frame.png"), D.dataUrlToFile(bUrl, "build.png")];
		let note = `The first image is the Figma frame "${state.fig.name}", the second image is the build (${state.build.label}), both at ${state.norm.w}×${state.norm.h}.`;
		if (state.diff) {
			files.push(D.dataUrlToFile(state.diff.canvas.toDataURL("image/png"), "diff.png"));
			note += ` The third image marks the differing areas in red on the build (${state.diff.matchPct.toFixed(1)} % match). Compare them and list what to fix.`;
		} else note += " Compare them and list what to fix.";
		await D.sendToChat(files, note);
	}

	registerDesignView({ id: "compare", label: "Compare", mount });

	// For the self-test.
	selftestSteps.push(async ({ snap, wait }) => {
		const page = (bg, box) => `<body style="margin:0;font:600 28px sans-serif;background:${bg};color:#fff;height:100vh"><div style="padding:24px">Pricing</div><div style="position:absolute;left:${box}px;top:120px;width:160px;height:90px;background:#fa0;border-radius:8px"></div></body>`;
		const dataUrl = (h) => `data:text/html;charset=utf-8,${encodeURIComponent(h)}`;
		const a = await crust.snap.url(dataUrl(page("#246", 40)), { width: 480, height: 300, kind: "design" });
		const b = await crust.snap.url(dataUrl(page("#246", 90)), { width: 480, height: 300, kind: "design" });
		if (!a.ok || !b.ok) return console.error(`SELFTEST design compare: capture failed ${a.error || b.error} -> MISMATCH`);
		switchTab("design");
		D.select("compare");
		await wait(300);
		await setFigma(await crust.snap.get(a.entry.id), { w: 480, h: 300, name: "Pricing card" });
		await setBuild(await crust.snap.get(b.entry.id), "fake build");
		await wait(600);
		await snap("design-compare");
		D.compare.setMode("diff");
		await wait(600);
		const d = state.diff;
		console.error(`SELFTEST pixel diff: ${d ? `${d.matchPct.toFixed(1)} % match, ${d.diffCount} px, ${d.regions} regions` : "none"} -> ${d && d.matchPct > 60 && d.matchPct < 99 && d.regions >= 1 && d.regions <= 4 ? "OK" : "MISMATCH"}`);
		console.error(`SELFTEST design tab: order=${tabOrder.join(",")} shortcut=${tabShortcut("design")} browserVisible=${(await crust.selftest.bounds()).visible} -> ${tabOrder.includes("design") && !(await crust.selftest.bounds()).visible ? "OK" : "MISMATCH"}`);
		await snap("design-diff");
		const was = themeSetting();
		setTheme(currentTheme() === "dark" ? "light" : "dark");
		await wait(600);
		await snap(`design-diff-${currentTheme()}`);
		D.compare.setMode("slider");
		await wait(300);
		await snap(`design-compare-${currentTheme()}`);
		setTheme(was);
		await wait(400);
	});

	D.compare = { setFigma, setBuild, state, ready: () => new Promise((r) => setTimeout(r, 0)).then(() => seq), setMode: (m) => [...document.querySelectorAll(".dv-stage .cmp-modes button")].find((b) => b.textContent.toLowerCase().startsWith(m))?.click() };
})();
