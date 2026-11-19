// Self-test step `viewer-tools`: the Viewer's tools per tab (Viewer tabs spec, section B "Active tab" and "Image or PDF in the active tab"; tasks 6 and 8).
// Four groups: the browser tools (CDP, target, forced states, colour scheme) on a switch; Tweak CSS per tab; a capture uses its tab's session; the
// kind of the active tab (page, image, PDF) and the disabled-with-reason rules, every cell of the table. The expected table below is written out
// here on purpose: it is not read from src/viewer-kind.js. Run: npm run selftest -- viewer-tools   (set PI_CRUST_VT_SHOTDIR for the screenshots).
// Deliberate breaks, each must report MISMATCH: PI_CRUST_SELFTEST_VIEWER_BREAK = tools-leave (the browser tools keep their state on the tab left),
// tweak-leave (Tweak CSS stays on the tab left), capture-session (the offscreen capture window uses the web session), kind-capture (a PDF is captured).
"use strict";

selftestSteps.push(async () => {
	const checks = [];
	const check = (name, ok, detail) => {
		checks.push({ name, ok: !!ok });
		console.error(`SELFTEST viewer-tools ${name}: ${ok ? "OK" : "MISMATCH" + (detail === undefined ? "" : " (" + String(detail).slice(0, 300) + ")")}`);
	};
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	const B = crust.browser;
	const T = (op) => crust.selftest.viewerTabs(op);
	const list = () => B.tabs();
	const byId = (l, id) => l.tabs.find((t) => t.id === id);
	const events = [];
	B.onState((s) => events.push(s));
	const settled = async (id) => {
		for (let i = 0; i < 80; i++) {
			const t = byId(await list(), id);
			if (t && !t.loading && t.address) return t;
			await sleep(100);
		}
		return byId(await list(), id);
	};
	const activate = async (id) => {
		const r = await B.activateTab(id);
		await settled(id);
		await sleep(500);
		return r;
	};
	const js = async (tab, code) => {
		const r = await T({ op: "js", tab, code });
		return r.error ? `ERR ${r.error}` : r.value;
	};
	const probeOf = async (id) => (await T("probe")).tabs.find((t) => t.id === id);
	const until = async (fn, ms = 4000) => {
		for (let t = 0; t < ms; t += 100) {
			if (await fn()) return true;
			await sleep(100);
		}
		return !!(await fn());
	};
	const pixel = async (dataUrl) => {
		const img = new Image();
		img.src = dataUrl;
		await img.decode();
		const c = document.createElement("canvas");
		c.width = img.naturalWidth;
		c.height = img.naturalHeight;
		const g = c.getContext("2d");
		g.drawImage(img, 0, 0);
		const [r, gr, b] = g.getImageData(c.width >> 1, c.height >> 1, 1, 1).data;
		return r > 150 && gr < 60 && b < 60 ? "red" : gr > 150 && r < 60 && b < 60 ? "green" : b > 150 && r < 60 && gr < 60 ? "blue" : `other(${r},${gr},${b})`;
	};
	// The Viewer tab is not the shown one: the view is hidden and keeps its bounds, and can be captured (the way the timeline step does it).
	const away = async () => {
		switchTab("changes");
		await sleep(600);
	};
	const back = async () => {
		switchTab("browser");
		await sleep(600);
	};
	// A view that was never shown has no surface to capture: show the tab first, then hide the Viewer (the view keeps its bounds).
	const ready = async (id) => {
		await back();
		await activate(id);
		// A page that does not change makes no new frame in an offscreen run, and a view with no frame has no surface to capture: nudge it.
		document.querySelector("#pick-element").focus();
		setTheme("dark");
		await sleep(400);
		setTheme("light");
		await sleep(400);
		await sleep(500);
		await away();
	};
	const MQ = "matchMedia('(prefers-color-scheme: dark)').matches";
	let S;
	try {
		S = await T("start");
		const web = `http://127.0.0.1:${S.port}/`;
		await crust.selftest.focusEmulation(true); // the offscreen window has no focus: let focus events and :focus work anyway
		switchTab("browser");
		await sleep(400);
		const first = (await list()).tabs[0].id;
		let r = await B.createTab(web);
		const w1 = r.tabId;
		r = await B.createTab(S.page);
		const p1 = r.tabId;
		r = await B.createTab(S.page2);
		const p2 = r.tabId;
		for (const id of [w1, p1, p2]) await settled(id);

		// === 1. Browser tools on a switch ============================================================================================
		await activate(w1);
		const base = await js(w1, MQ);
		const want = base ? "light" : "dark";
		await B.scheme(want);
		await sleep(300);
		check("tools: the colour scheme applies to the active web tab", (await js(w1, MQ)) === (want === "dark"), await js(w1, MQ));
		await T({ op: "notePick", selector: "#x" });
		check("tools: a picked target is set", (await B.target()).selector === "#x");
		const fr = await B.forceState({ pseudo: [], disabled: true });
		check("tools: a forced state is applied to the target", !!fr.ok && (await js(w1, "document.querySelector('#x').getAttribute('aria-disabled')")) === "true", JSON.stringify(fr));
		check("tools: the debugger is attached to the active tab", (await probeOf(w1)).debuggerAttached === true);
		await activate(p1);
		check("switch: the target is cleared", (await B.target()).selector === null, JSON.stringify(await B.target()));
		check("switch: the forced state is gone from the tab left", (await js(w1, "document.querySelector('#x').getAttribute('aria-disabled')")) === null);
		check("switch: the debugger is detached from the tab left", (await probeOf(w1)).debuggerAttached === false);
		check("switch: the emulated colour scheme is gone from the tab left", (await js(w1, MQ)) === base);
		check("switch: the colour scheme is one Viewer setting, applied to the new active tab (a project page)", (await B.scheme()) === want && (await js(p1, MQ)) === (want === "dark"), `${await B.scheme()} ${await js(p1, MQ)}`);
		const boxes = [...document.querySelectorAll("#state-bar input")];
		check("switch: the State row shows no target and nothing checked", boxes.length === 5 && boxes.every((b) => !b.checked && b.disabled) && document.querySelector("#state-bar .sb-path").textContent === "Pick or tweak an element first", document.querySelector("#state-bar .sb-path").textContent);
		await activate(w1);
		check("back: no stale target or forced state", (await B.target()).selector === null && (await js(w1, "document.querySelector('#x').getAttribute('aria-disabled')")) === null);
		check("back: the scheme is applied again here and gone from the other tab", (await js(w1, MQ)) === (want === "dark") && (await js(p1, MQ)) === base && (await probeOf(p1)).debuggerAttached === false);
		await B.scheme("auto");
		await sleep(200);
		check("back: Auto removes the override", (await js(w1, MQ)) === base);

		// === 2. Tweak CSS per tab ====================================================================================================
		const color = "getComputedStyle(document.querySelector('p')).color";
		await activate(p1);
		const c0 = await js(p1, color);
		const keyA = await B.insertCss("p { color: rgb(1, 2, 3) !important; }");
		check("tweak: CSS goes into the active tab (a project page)", !!keyA && (await js(p1, color)) === "rgb(1, 2, 3)", `${keyA} ${await js(p1, color)}`);
		await activate(p2);
		check("tweak: a switch never puts it into the other tab", (await js(p2, color)) !== "rgb(1, 2, 3)", await js(p2, color));
		check("tweak: a switch takes it out of the tab left", (await js(p1, color)) === c0, await js(p1, color));
		const keyB = await B.insertCss("p { color: rgb(4, 5, 6) !important; }");
		await B.removeCss(keyA); // a stale key from the other tab
		check("tweak: a stale key from another tab does not touch this tab's CSS", (await js(p2, color)) === "rgb(4, 5, 6)", await js(p2, color));
		await activate(p1);
		check("tweak: coming back shows no CSS on either tab", (await js(p1, color)) === c0 && (await js(p2, color)) !== "rgb(4, 5, 6)", `${await js(p1, color)} ${await js(p2, color)}`);
		const keyC = await B.insertCss("p { color: rgb(7, 8, 9) !important; }");
		await B.removeCss(keyC);
		check("tweak: a reset removes it from its own tab", (await js(p1, color)) === c0, await js(p1, color));
		void keyB;

		// === 3. A capture uses its tab's session =====================================================================================
		r = await B.createTab(S.capPage);
		const cap = r.tabId;
		await settled(cap);
		let shot = await crust.snap.url(S.capPage, { width: 200, height: 120, kind: "design" });
		check("capture: a project page with nothing stored in the project session is red", shot.ok && (await pixel(await crust.snap.get(shot.entry.id))) === "red", shot.error);
		await js(cap, "localStorage.setItem('k', 'project')");
		shot = await crust.snap.url(S.capPage, { width: 200, height: 120, kind: "design" });
		check("capture: a value stored in that project's session is in the capture (green)", shot.ok && (await pixel(await crust.snap.get(shot.entry.id))) === "green", shot.ok ? await pixel(await crust.snap.get(shot.entry.id)) : shot.error);
		await js(w1, "localStorage.setItem('k', 'web')");
		const wshot = await crust.snap.url(S.webCap, { width: 200, height: 120, kind: "design" });
		check("capture: a web address is captured with the web session (blue)", wshot.ok && (await pixel(await crust.snap.get(wshot.entry.id))) === "blue", wshot.ok ? await pixel(await crust.snap.get(wshot.entry.id)) : wshot.error);
		check("capture: the web session's value is not in the project capture", shot.ok && (await pixel(await crust.snap.get(shot.entry.id))) !== "blue");
		await js(cap, "location.reload()");
		await settled(cap);
		await ready(cap); // a shown view cannot be captured in an offscreen run on this machine; a hidden one keeps its bounds (as for a turn's shots)
		const live = await crust.snap.live({ kind: "design" });
		await back();
		check("capture: the live capture of the project tab shows its session's value", live.ok && (await pixel(await crust.snap.get(live.entry.id))) === "green", live.ok ? await pixel(await crust.snap.get(live.entry.id)) : live.error);
		await B.closeTab(cap);
		await B.closeTab(p2);

		// === 4. The kind of the active tab ===========================================================================================
		r = await B.createTab(S.big);
		const img = r.tabId;
		r = await B.createTab(S.svg);
		const svg = r.tabId;
		r = await B.createTab(S.pdf);
		const pdf = r.tabId;
		for (const id of [img, svg, pdf]) await settled(id);
		const IMG = "Needs a web page. This tab shows an image.";
		const PDF = "Needs a web page. This tab shows a PDF.";
		const PDF_OR_IMG = "Needs a web page or an image. This tab shows a PDF.";
		const NODES = { pick: "#pick-element", tweak: "#tweak-btn", scheme: "#scheme-btn", state: "#state-btn", annotate: "#annotate-btn" };
		// kind -> feature -> the reason, or "" when it works
		const EXPECT = {
			page: { pick: "", tweak: "", scheme: "", state: "", annotate: "", capture: "", viewports: "" },
			image: { pick: IMG, tweak: IMG, scheme: IMG, state: IMG, annotate: "", capture: "", viewports: "" },
			pdf: { pick: PDF, tweak: PDF, scheme: PDF, state: PDF, annotate: PDF_OR_IMG, capture: PDF_OR_IMG, viewports: PDF_OR_IMG },
		};
		// The Design tab's own buttons: Capture build and the Viewports refresh, mounted once.
		switchTab("design");
		await sleep(300);
		document.querySelector('#design-views [data-view="compare"]').click();
		await sleep(300);
		document.querySelector('#design-views [data-view="viewports"]').click();
		await sleep(300);
		const captureBtn = () => [...document.querySelectorAll("#design-host button")].find((b) => b.textContent === "Capture build");
		const vpBtn = () => document.querySelector('#design-host [data-view="viewports"] button[aria-label="Refresh"]');
		check("design: Capture build and the Viewports refresh button exist", !!captureBtn() && !!vpBtn());
		const stateOf = (node) => ({ off: node.getAttribute("aria-disabled") === "true", title: node.title, desc: node.getAttribute("aria-description") });
		const cases = [
			["page", w1],
			["page", p1],
			["image", img],
			["image", svg],
			["pdf", pdf],
		];
		for (const [kind, id] of cases) {
			await activate(id);
			const tab = byId(await list(), id);
			check(`kind ${kind} (${id === svg ? "svg" : id === img ? "png" : "tab"}): the tab reports its kind`, tab.kind === kind, tab.kind);
			for (const [f, sel] of Object.entries(NODES)) {
				const node = document.querySelector(sel);
				const st = stateOf(node);
				const why = EXPECT[kind][f];
				check(`kind ${kind}: ${f} ${why ? "is disabled with the reason" : "works"}`, why ? st.off && st.title === why && st.desc === why && node.classList.contains("is-disabled") : !st.off && !node.classList.contains("is-disabled"), JSON.stringify(st));
			}
			for (const [f, node] of [["capture", captureBtn()], ["viewports", vpBtn()]]) {
				const st = stateOf(node);
				const why = EXPECT[kind][f];
				check(`kind ${kind}: ${f} ${why ? "is disabled with the reason" : "works"}`, why ? st.off && st.title === why && st.desc === why : !st.off, JSON.stringify(st));
			}
			if (kind === "pdf") {
				const grid = document.querySelector('#design-host [data-view="viewports"] .vp-grid');
				check("kind pdf: Viewports shows the reason instead of tiles", !!grid && grid.textContent.includes(PDF_OR_IMG), grid && grid.textContent);
			}
		}
		switchTab("browser");
		await sleep(400);

		// A disabled tool stays focusable and shows its reason inside the row on focus.
		for (const [id, f, why] of [[img, "tweak", IMG], [pdf, "annotate", PDF_OR_IMG], [pdf, "pick", PDF]]) {
			await activate(id);
			const node = document.querySelector(NODES[f]);
			node.focus();
			const line = document.querySelector("#vt-reason");
			const row = document.querySelector("#viewer-tabs").getBoundingClientRect();
			const lr = line.getBoundingClientRect();
			check(`reason: ${f} on a ${id === pdf ? "PDF" : "image"} can be focused and shows its reason in the row`, document.activeElement === node && getComputedStyle(line).visibility === "visible" && line.textContent === why && lr.top >= row.top - 0.5 && lr.bottom <= row.bottom + 0.5, `${document.activeElement === node} ${line.textContent}`);
			node.click();
			await sleep(200);
			check(`reason: clicking the disabled ${f} does nothing`, !node.hasAttribute("aria-pressed") || node.getAttribute("aria-pressed") === "false");
			node.blur();
		}
		// Pick (and so Tweak) is refused by the main process too.
		await activate(img);
		let pr = await B.pick({});
		check("image: a pick is refused with the reason", pr && pr.error === IMG, JSON.stringify(pr));
		await activate(pdf);
		pr = await B.pick({});
		check("pdf: a pick is refused with the reason", pr && pr.error === PDF, JSON.stringify(pr));
		check("pdf: the forced states and the scheme have nothing to act on", (await B.forceState({ pseudo: ["hover"] })).error === "Needs a web page");

		// Captures. Annotate and Capture build use snap.live / snap.url; a turn's shots use pageOnly. (View hidden, see above.)
		await ready(img);
		let c = await crust.snap.live({ kind: "design" });
		// A project image's view often has no surface to capture in an offscreen run on this machine ("display surface not available"; the same
		// error that fails the step annotate on main). What the rule decides is whether the capture is refused: it must not be.
		check("image: Annotate / Capture build (live) are not refused (the capture itself may fail on this machine)", !!c.ok || (!!c.error && !/This tab shows/.test(c.error)), c.error);
		c = await crust.snap.url(S.big, { width: 400, height: 300, kind: "design" });
		check("image: Capture build / Viewports (the address in an offscreen window) work", !!c.ok, c.error);
		c = await crust.snap.live({ pageOnly: true, skipEmpty: true });
		check("image: no before/after shot is taken", !c.ok && c.error === IMG, JSON.stringify(c));
		await ready(pdf);
		c = await crust.snap.live({ kind: "design" });
		check("pdf: Annotate / Capture build (live) are refused with the reason", !c.ok && c.error === PDF_OR_IMG, JSON.stringify(c));
		c = await crust.snap.url(S.pdf, { width: 400, height: 300, kind: "design" });
		check("pdf: Capture build / Viewports (the address) are refused with the reason", !c.ok && c.error === PDF_OR_IMG, JSON.stringify(c));
		c = await crust.snap.live({ pageOnly: true, skipEmpty: true });
		check("pdf: no before/after shot is taken", !c.ok && c.error === PDF, JSON.stringify(c));
		await ready(w1);
		c = await crust.snap.live({ pageOnly: true });
		check("page: a before/after shot is taken", !!c.ok, c.error);
		const onW1 = c.tabId;
		await activate(p1);
		c = await crust.snap.live({ pageOnly: true, onlyTab: onW1 });
		check("page: an after shot is refused when another tab is active than the before shot's", !!onW1 && !c.ok, JSON.stringify(c));
		await back();

		// Back, forward, reload, DevTools and the system browser work on every kind.
		for (const [id, name, ext] of [[img, "image", "big.png"], [pdf, "pdf", "doc.pdf"], [w1, "web page", null]]) {
			await activate(id);
			for (const a of ["back", "forward", "reload", "devtools", "external"]) {
				const n = document.querySelector(`.browser-bar [data-action="${a}"]`);
				check(`nav ${name}: ${a} is not disabled by the kind`, n.getAttribute("aria-disabled") !== "true" && !n.classList.contains("is-disabled"));
			}
			events.length = 0;
			await B.action("reload");
			check(`nav ${name}: reload reloads the tab`, await until(() => events.some((e) => e.tabs.find((t) => t.id === id)?.loading), 3000));
			await settled(id);
			await B.action("external");
			const x = (await T("external")).last;
			check(`nav ${name}: "open in system browser" has a target`, ext ? !!x && !!x.file && x.file.replace(/\\/g, "/").endsWith(`/${ext}`) : !!x && x.url === web, JSON.stringify(x));
		}

		// The image tab: neutral background, fit and 100 percent.
		await activate(img);
		const zoomBox = document.querySelector("#vt-zoom");
		const imgJs = "(() => { const i = document.images[0]; const b = i.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height), nw: i.naturalWidth, iw: window.innerWidth, bg: getComputedStyle(document.body).backgroundColor }; })()";
		const fit = await js(img, imgJs);
		check("image tab: the zoom group shows Fit and 100%, Fit pressed", !zoomBox.hidden && zoomBox.querySelector('[data-zoom="fit"]').getAttribute("aria-pressed") === "true" && zoomBox.querySelector('[data-zoom="actual"]').textContent === "100%");
		check("image tab: fitted, the whole image is inside the view", fit.nw === 1600 && fit.w < 1600 && fit.w <= fit.iw + 1 && Math.abs(fit.w / fit.h - 4 / 3) < 0.02, JSON.stringify(fit));
		check("image tab: a neutral background", ["rgb(222, 222, 222)", "rgb(43, 43, 43)"].includes(fit.bg), fit.bg);
		zoomBox.querySelector('[data-zoom="actual"]').click();
		await until(async () => (await js(img, imgJs)).w === 1600);
		const real = await js(img, imgJs);
		check("image tab: 100% shows the real size (1600 x 1200)", real.w === 1600 && real.h === 1200, JSON.stringify(real));
		check("image tab: 100% is pressed", zoomBox.querySelector('[data-zoom="actual"]').getAttribute("aria-pressed") === "true");
		zoomBox.querySelector('[data-zoom="fit"]').click();
		await until(async () => (await js(img, imgJs)).w < 1600);
		check("image tab: Fit again", (await js(img, imgJs)).w < 1600);
		await activate(svg);
		const svgJs = "(() => { const b = document.documentElement.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height), iw: window.innerWidth }; })()";
		const sf = await js(svg, svgJs);
		check("svg tab: fitted, an SVG fills the view", Math.abs(sf.w - sf.iw) <= 2, JSON.stringify(sf));
		zoomBox.querySelector('[data-zoom="actual"]').click();
		await until(async () => (await js(svg, svgJs)).w === 40);
		const sa = await js(svg, svgJs);
		check("svg tab: 100% is its own size (40 x 30)", sa.w === 40 && sa.h === 30, JSON.stringify(sa));
		await activate(pdf);
		check("the zoom group is for image tabs only", zoomBox.hidden);
		await activate(w1);
		check("the zoom group is hidden on a web page", zoomBox.hidden);

		// Annotate hides and restores the active tab's view only.
		await B.hide(true, "annotate");
		await sleep(200);
		let pa = await T("probe");
		check("annotate: while it is open no tab's view is shown", pa.tabs.every((t) => !t.visible));
		await B.hide(false, "annotate");
		await sleep(200);
		pa = await T("probe");
		check("annotate: afterwards exactly the active tab's view is shown again", pa.tabs.filter((t) => t.visible).length === 1 && pa.tabs.find((t) => t.visible).isCtxView, JSON.stringify(pa.tabs));

		// Screenshots: an image tab and a PDF tab, a disabled tool's reason showing, light and dark.
		if (!window.__vtNoShots) {
			for (const [id, name, f] of [[img, "image", "tweak"], [pdf, "pdf", "annotate"]]) {
				await activate(id);
				for (const th of ["light", "dark"]) {
					setTheme(th);
					await sleep(800);
					const node = document.querySelector(NODES[f]);
					node.focus();
					await sleep(200);
					const sw = await T({ op: "shot", what: "win" });
					await away();
					const sv = await T({ op: "shot", what: "view" });
					await back();
					const wi = new Image();
					wi.src = sw.win;
					await wi.decode();
					const c2 = document.createElement("canvas");
					c2.width = wi.naturalWidth;
					c2.height = wi.naturalHeight;
					const g = c2.getContext("2d");
					g.drawImage(wi, 0, 0);
					if (sv.view && sv.bounds) {
						const vi = new Image();
						vi.src = sv.view;
						await vi.decode();
						const k = wi.naturalWidth / (innerWidth * sv.z);
						g.drawImage(vi, sv.bounds.x * k, sv.bounds.y * k, sv.bounds.width * k, sv.bounds.height * k);
					}
					const saved = await T({ op: "saveShot", name: `vt-kind-${name}-${th}-v2`, dataUrl: c2.toDataURL("image/png") });
					console.error(`SELFTEST viewer-tools screenshot ${name} ${th}: ${saved.ok ? saved.file : "not saved (PI_CRUST_VT_SHOTDIR unset)"}`);
					node.blur();
				}
			}
			setTheme("light");
		}
	} catch (e) {
		check("no exception", false, e && e.stack ? e.stack : e);
	} finally {
		await B.scheme("auto").catch(() => {});
		await T("stop").catch(() => {});
	}
	const bad = checks.filter((c) => !c.ok).length;
	console.error(`SELFTEST viewer-tools: ${checks.length} checks, ${bad ? bad + " MISMATCH" : "all OK"}`);
}, "viewer-tools");
