// Tweak panel: pick one element in the Viewer tab, then change its padding, gap, radius, font size and colours with
// sliders and token dropdowns, live in the page (injected CSS, nothing is written to your files). "Apply with Pi" sends
// a precise before -> after request with the element's context; "Add to composer" only puts it in the chat input.
// Sliders snap to the page's tokens; hold ⌥ for free values. The preview CSS is removed when files change next.
"use strict";

(() => {
	const D = window.crustDesign;
	const TM = window.TokenMatch;
	const panel = $("#tweak-panel");
	const SIDES = ["top", "right", "bottom", "left"];
	const SNAP = 2; // px a slider is pulled to a token
	let t = null; // { block, selector, tag, orig, cur, snaps, colors, key, applied, linked }
	let altDown = false;
	let picking = false;
	let cssSeq = 0;
	let cssTimer = 0;

	addEventListener("keydown", (e) => e.key === "Alt" && (altDown = true), true);
	addEventListener("keyup", (e) => e.key === "Alt" && (altDown = false), true);
	addEventListener("blur", () => (altDown = false));

	const ICON = (d) => `<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
	const px = (n) => `${Math.round(n * 100) / 100}px`;
	const rgbToHex = (str) => {
		const c = TM.normalizeColor(str);
		return c ? `#${[c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, "0")).join("")}` : "";
	};

	// --- opening ---------------------------------------------------------------------------------
	async function start() {
		if (picking) return void crust.browser.pick(); // a second press cancels the running pick
		if (window.crustViewerKind && !crustViewerKind.can("tweak")) return toast(crustViewerKind.reason("tweak"), "warning"); // an image or a PDF tab
		picking = true;
		const btn = $("#tweak-btn");
		btn.setAttribute("aria-pressed", "true");
		try {
			if (activeTab !== "browser") {
				switchTab("browser");
				await new Promise((r) => setTimeout(r, 150));
			}
			const r = await crust.browser.pick(D.pickOpts());
			if (r.error) return toast(`Pick failed: ${r.error}`, "error");
			if (!r.raw?.length) return;
			await openFor(r.raw[0], r.items[0]);
		} finally {
			picking = false;
			btn.removeAttribute("aria-pressed");
		}
	}

	async function openFor(el0, block) {
		await closePanel(false);
		const info = await crust.design.inspect(el0.selector);
		if (info.error) return toast(info.error, "error");
		const lengths = [...info.tokens.vars.filter((v) => v.kind === "length"), ...(info.tokens.mui ? [...info.tokens.mui.spacing, ...info.tokens.mui.radius] : [])];
		const colors = [...info.tokens.vars.filter((v) => v.kind === "color"), ...(info.tokens.mui?.palette || [])];
		const snapsOf = (list) => [...new Set(list.map((l) => TM.toPx(l.value)).filter((v) => v != null && v >= 0))].sort((a, b) => a - b);
		const radii = lengths.filter((l) => /radius|round/i.test(l.name));
		const fonts = [...lengths.filter((l) => /font|text|size/i.test(l.name)), ...(info.tokens.mui?.typography || []).map((x) => ({ value: x.fontSize }))];
		const orig = { padding: info.padding, gap: info.gap, radius: info.radius, fontSize: info.fontSize, color: info.color, background: info.background };
		t = {
			block,
			selector: el0.selector,
			tag: info.tag,
			display: info.display,
			orig,
			cur: JSON.parse(JSON.stringify(orig)),
			curCss: {}, // colour props -> css value to inject
			snaps: { spacing: snapsOf(lengths), radius: snapsOf(radii.length ? radii : lengths), font: snapsOf(fonts) },
			lengths,
			radii: radii.length ? radii : lengths,
			colors,
			key: null,
			applied: false,
			linked: new Set(orig.padding).size === 1,
		};
		render();
		panel.hidden = false;
		panel.querySelector("input, select, button")?.focus();
	}

	// --- panel -----------------------------------------------------------------------------------
	function snap(v, list, free) {
		if (free || !list.length) return v;
		const near = list.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a));
		return Math.abs(near - v) <= SNAP ? near : v;
	}

	function slider(label, value, { max = 64, snaps = [], tokens = [], onChange }) {
		const row = el("div", "tw-row");
		const id = `tw-${Math.random().toString(36).slice(2, 8)}`;
		const lab = el("label", "tw-label", label);
		lab.htmlFor = id;
		const range = el("input");
		range.type = "range";
		range.id = id;
		range.min = "0";
		range.max = String(Math.max(max, Math.ceil(value * 2)));
		range.step = "1";
		range.value = String(Math.round(value));
		const num = el("span", "tw-num");
		const tok = el("span", "tw-tok");
		const show = (v) => {
			num.textContent = px(v);
			const m = TM.matchLength(v, tokens);
			tok.textContent = m.token || "";
			tok.hidden = !m.token;
			tok.title = m.token ? `Matches ${m.token}` : "";
		};
		show(value);
		range.addEventListener("input", () => {
			const v = snap(Number(range.value), snaps, altDown);
			range.value = String(v);
			show(v);
			onChange(v);
		});
		row.append(lab, range, num, tok);
		row.set = (v) => {
			range.value = String(Math.round(v));
			show(v);
		};
		return row;
	}

	function colorRow(label, prop) {
		const row = el("div", "tw-row tw-color");
		const id = `tw-${Math.random().toString(36).slice(2, 8)}`;
		const lab = el("label", "tw-label", label);
		lab.htmlFor = id;
		const sel = el("select");
		sel.id = id;
		const none = new Option("Keep current", "");
		sel.append(none);
		t.colors.forEach((c, i) => sel.append(new Option(c.name, String(i))));
		sel.append(new Option("Custom…", "custom"));
		const pickr = el("input", "tw-swatch");
		pickr.type = "color";
		pickr.setAttribute("aria-label", `${label} colour`);
		const cur = prop === "color" ? t.orig.color : t.orig.background;
		pickr.value = rgbToHex(cur) || "#000000";
		const m = TM.matchColor(cur, t.colors);
		sel.value = "";
		const apply = (css, value) => {
			t.cur[prop === "color" ? "color" : "background"] = value;
			t.curCss[prop] = css;
			schedule();
		};
		sel.onchange = () => {
			if (sel.value === "") {
				delete t.curCss[prop];
				t.cur[prop === "color" ? "color" : "background"] = cur;
				pickr.value = rgbToHex(cur) || pickr.value;
				return schedule();
			}
			if (sel.value === "custom") return pickr.click();
			const c = t.colors[Number(sel.value)];
			pickr.value = rgbToHex(c.value) || pickr.value;
			apply(c.name.startsWith("--") ? `var(${c.name})` : c.value, c.value);
		};
		pickr.oninput = () => {
			sel.value = "custom";
			apply(pickr.value, pickr.value);
		};
		const hint = el("span", "tw-tok", m.token ? m.token : "");
		hint.hidden = !m.token;
		row.append(lab, sel, pickr, hint);
		return row;
	}

	function render() {
		const rows = [];
		const head = el("header", "pane-header tw-head");
		const name = el("span", "pane-title", "Tweak");
		const what = el("span", "tw-what muted", `<${t.tag}>`);
		what.title = t.selector;
		const iconBtn = (svg, label, fn) => {
			const b = el("button", "icon");
			b.type = "button";
			b.title = label;
			b.setAttribute("aria-label", label);
			b.innerHTML = svg;
			b.onclick = fn;
			return b;
		};
		head.append(name, what, el("span", "spacer"), iconBtn(ICON('<path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9"/><path d="M13.5 2.5v3h-3"/>'), "Reset", reset), iconBtn(ICON('<path d="M4 4l8 8M12 4l-8 8"/>'), "Close", () => closePanel(true)));

		const body = el("div", "tw-body scroll");
		const pad = el("div", "tw-group");
		const linkedRow = slider("Padding", Math.max(...t.orig.padding), {
			snaps: t.snaps.spacing,
			tokens: t.lengths,
			onChange: (v) => {
				t.cur.padding = [v, v, v, v];
				sides.forEach((s) => s.set(v));
				schedule();
			},
		});
		const sides = SIDES.map((side, i) =>
			slider(side[0].toUpperCase() + side.slice(1), t.orig.padding[i], {
				snaps: t.snaps.spacing,
				tokens: t.lengths,
				onChange: (v) => {
					t.cur.padding[i] = v;
					schedule();
				},
			}),
		);
		const per = el("label", "tw-check");
		const cb = el("input");
		cb.type = "checkbox";
		cb.checked = !t.linked;
		per.append(cb, " Per side");
		const paintSides = () => {
			linkedRow.hidden = cb.checked;
			sides.forEach((s) => (s.hidden = !cb.checked));
		};
		cb.onchange = () => {
			if (!cb.checked) {
				const v = Math.max(...t.cur.padding);
				t.cur.padding = [v, v, v, v];
				linkedRow.set(v);
				sides.forEach((s) => s.set(v));
				schedule();
			}
			paintSides();
		};
		paintSides();
		pad.append(linkedRow, ...sides, per);
		rows.push(pad);
		if (/flex|grid/.test(t.display)) {
			rows.push(slider("Gap", t.orig.gap, { snaps: t.snaps.spacing, tokens: t.lengths, onChange: (v) => ((t.cur.gap = v), schedule()) }));
		}
		rows.push(slider("Radius", t.orig.radius, { max: 48, snaps: t.snaps.radius, tokens: t.radii, onChange: (v) => ((t.cur.radius = v), schedule()) }));
		rows.push(slider("Font size", t.orig.fontSize, { max: 48, snaps: t.snaps.font, tokens: t.lengths, onChange: (v) => ((t.cur.fontSize = v), schedule()) }));
		rows.push(colorRow("Colour", "color"), colorRow("Background", "background-color"));
		const hint = el("p", "tw-hint muted", t.snaps.spacing.length ? "Values snap to the page's tokens. Hold " + keyLabel("⌥") + " for free values." : "No theme tokens found, so values are free.");
		body.append(...rows, hint);

		const foot = el("div", "tw-foot");
		const add = el("button", "btn secondary", "Add to composer");
		add.type = "button";
		add.onclick = () => send(false);
		const apply = el("button", "btn", `Apply with ${agentLabel()}`);
		apply.type = "button";
		apply.onclick = () => send(true);
		foot.append(add, apply);
		panel.replaceChildren(head, body, foot);
	}

	// --- live CSS --------------------------------------------------------------------------------
	function changes() {
		const { orig, cur } = t;
		const list = [];
		if (cur.padding.some((v, i) => v !== orig.padding[i])) {
			const same = new Set(cur.padding).size === 1;
			list.push({ prop: "padding", css: same ? px(cur.padding[0]) : cur.padding.map(px).join(" "), from: new Set(orig.padding).size === 1 ? px(orig.padding[0]) : orig.padding.map(px).join(" "), to: same ? px(cur.padding[0]) : cur.padding.map(px).join(" "), lengthTo: same ? cur.padding[0] : null });
		}
		if (cur.gap !== orig.gap) list.push({ prop: "gap", css: px(cur.gap), from: px(orig.gap), to: px(cur.gap), lengthTo: cur.gap });
		if (cur.radius !== orig.radius) list.push({ prop: "border-radius", css: px(cur.radius), from: px(orig.radius), to: px(cur.radius), lengthTo: cur.radius, radius: true });
		if (cur.fontSize !== orig.fontSize) list.push({ prop: "font-size", css: px(cur.fontSize), from: px(orig.fontSize), to: px(cur.fontSize), lengthTo: cur.fontSize });
		for (const prop of ["color", "background-color"]) {
			if (t.curCss[prop]) {
				const to = prop === "color" ? cur.color : cur.background;
				const m = TM.matchColor(to, t.colors);
				list.push({ prop, css: t.curCss[prop], from: prop === "color" ? orig.color : orig.background, to, token: m.token });
			}
		}
		for (const c of list) if (c.lengthTo != null) c.token = TM.matchLength(c.lengthTo, c.radius ? t.radii : t.lengths).token;
		return list;
	}

	function schedule() {
		clearTimeout(cssTimer);
		cssTimer = setTimeout(pushCss, 30);
	}
	async function pushCss() {
		const my = ++cssSeq;
		// Only values that are plain CSS values go into the page: no [;{}] (they would end the declaration or the rule) and colours
		// must parse.
		const safe = (c) => !/[;{}]/.test(c.css) && (!/color$/.test(c.prop) || !!TM.normalizeColor(c.css));
		const css = changes()
			.filter(safe)
			.map((c) => `${c.prop}: ${c.css} !important;`)
			.join(" ");
		const old = t?.key;
		const key = css ? await crust.browser.insertCss(`[data-pi-tweak="1"] { ${css} }`) : null;
		if (!t || my !== cssSeq) {
			if (key) crust.browser.removeCss(key);
			return;
		}
		t.key = key;
		if (old) crust.browser.removeCss(old);
	}

	function reset() {
		if (!t) return;
		t.cur = JSON.parse(JSON.stringify(t.orig));
		t.curCss = {};
		t.linked = new Set(t.orig.padding).size === 1;
		render();
		pushCss();
	}

	async function closePanel(announce) {
		clearTimeout(cssTimer);
		cssSeq++;
		if (t?.key) await crust.browser.removeCss(t.key);
		if (t) await crust.design.untag();
		t = null;
		panel.hidden = true;
		panel.replaceChildren();
		if (announce) $("#tweak-btn").focus();
	}

	// --- sending ---------------------------------------------------------------------------------
	function request() {
		const list = changes();
		if (!list.length) return null;
		const lines = list.map((c) => `- ${c.prop}: ${c.from} → ${c.to}${c.token ? ` (the theme token ${c.token})` : ""}`);
		return [
			"Change the styles of the element below in the source code to match these tweaks (I previewed them live in the browser):",
			...lines,
			"Use the theme's tokens or spacing scale where named; don't hard-code values the theme already has.",
		].join("\n");
	}

	async function send(now) {
		const text = request();
		if (!text) return toast("Change something first", "warning");
		if (!active) return toast("Open a chat first", "warning");
		if (now) {
			const ok = await sendPrompt(`${t.block}\n\n${text}`);
			if (!ok) return;
			t.applied = true; // the preview stays until the files change
			toast(`Sent to ${agentLabel()}. The preview stays until the files change.`, "info");
			return;
		}
		addPicks([t.block]);
		const input = $("#input");
		input.value = input.value ? `${input.value}\n${text}` : text;
		input.dispatchEvent(new Event("input", { bubbles: true }));
		toast("Added to the chat input", "info");
	}

	crust.fs.onChanged(() => {
		if (t?.applied) closePanel(false);
	});
	panel.addEventListener("keydown", (e) => {
		if (e.key === "Escape") {
			e.stopPropagation();
			closePanel(true);
		}
	});

	$("#tweak-btn").addEventListener("click", start);
	// A switch of tab: the main process has taken the Tweak CSS out of the tab being left; the panel and its element go too.
	crust.browser.onTabLeft(() => {
		if (t) closePanel(false);
	});
	const prev = window.crustPaletteActions;
	window.crustPaletteActions = () => [...(prev?.() || []), { label: "Tweak an element's styles", desc: "padding, radius, type, colours", run: start }];

	window.crustTweak = {
		open: openFor,
		close: () => closePanel(false),
		isOpen: () => !!t,
		changes: () => (t ? changes() : []),
		request,
	};

	selftestSteps.push(async ({ snap: shot, wait }) => {
		const page = `<style>:root{--space-2:8px;--space-3:16px;--radius-sm:4px;--brand:#ff0000;--ink:#222222}
			body{margin:0;font:14px sans-serif;background:#eee;padding:40px}
			.card{display:flex;gap:8px;padding:16px;border-radius:4px;background:#ff0000;color:#123456;width:320px}</style>
			<div class="card" id="c"><span>Card title</span><span>Second</span></div>`;
		await crust.snap.selftestLoad(page);
		switchTab("browser");
		await wait(800);
		const el0 = { selector: "#c", rect: { x: 40, y: 40, width: 320, height: 50 } };
		await openFor(el0, '<browser-element url="selftest">\nselector: #c\n</browser-element>');
		await wait(300);
		if (!t) return console.error("SELFTEST tweak: panel did not open -> MISMATCH");
		const range = panel.querySelector(".tw-row input[type=range]");
		range.value = "24";
		range.dispatchEvent(new Event("input", { bubbles: true }));
		await wait(600);
		const ch = changes();
		console.error(`SELFTEST tweak: changes=${JSON.stringify(ch.map((c) => `${c.prop} ${c.from}->${c.to}${c.token ? ` ${c.token}` : ""}`))} css=${!!t.key} -> ${ch.length === 1 && ch[0].to === "24px" && t.key ? "OK" : "MISMATCH"}`);
		await shot("tweak");
		const was = themeSetting();
		setTheme(currentTheme() === "dark" ? "light" : "dark");
		await wait(500);
		await shot(`tweak-${currentTheme()}`);
		setTheme(was);
		await wait(300);
		await closePanel(false);
		console.error(`SELFTEST tweak closed: panel hidden=${panel.hidden} -> ${panel.hidden ? "OK" : "MISMATCH"}`);
	});
})();
