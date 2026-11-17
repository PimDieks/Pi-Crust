// Annotate a screenshot of the Viewer tab's page: pen, arrow, box and text over the capture, a note, then "Add to chat"
// sends the marked-up PNG as an image pill (and the note into the input). The overlay covers the Viewer tab; the native
// browser view is hidden meanwhile (hide reason "annotate"). Esc cancels.
"use strict";

(() => {
	const D = window.crustDesign;
	const ICON = (d) => `<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
	const TOOLS = [
		{ id: "pen", label: "Pen", key: "p", icon: ICON('<path d="M10.5 2.5l3 3-7.5 7.5H3v-3z"/><path d="M9 4l3 3"/>') },
		{ id: "arrow", label: "Arrow", key: "a", icon: ICON('<path d="M3 13L13 3M7 3h6v6"/>') },
		{ id: "box", label: "Box", key: "b", icon: ICON('<rect x="2.5" y="3.5" width="11" height="9" rx="1"/>') },
		{ id: "text", label: "Text", key: "t", icon: ICON('<path d="M3 4V3h10v1M8 3v10M6 13h4"/>') },
	];
	const COLORS = [
		{ token: "--err", label: "Red" },
		{ token: "--warn", label: "Yellow" },
		{ token: "--ok", label: "Green" },
		{ token: "--accent", label: "Blue" },
	];
	let ov = null; // the open overlay's state

	function open(dataUrl) {
		close();
		const root = el("div", "annotate");
		root.setAttribute("role", "dialog");
		root.setAttribute("aria-label", "Annotate screenshot");
		const head = el("header", "pane-header an-bar");
		const seg = el("div", "seg an-tools");
		seg.setAttribute("role", "toolbar");
		seg.setAttribute("aria-label", "Tools");
		const colors = el("div", "an-colors");
		colors.setAttribute("role", "toolbar");
		colors.setAttribute("aria-label", "Colour");
		const iconBtn = (svg, label, onclick) => {
			const b = el("button", "icon");
			b.type = "button";
			b.title = label;
			b.setAttribute("aria-label", label);
			b.innerHTML = svg;
			b.onclick = onclick;
			return b;
		};
		const undoBtn = iconBtn(ICON('<path d="M5.5 3L2.5 6l3 3M3 6h6a4 4 0 0 1 0 8H6"/>'), keyLabel("Undo (⌘Z)"), () => undo());
		const redoBtn = iconBtn(ICON('<path d="M10.5 3l3 3-3 3M13 6H7a4 4 0 0 0 0 8h3"/>'), keyLabel("Redo (⌘⇧Z)"), () => redo());
		const clearBtn = iconBtn(ICON('<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5"/>'), "Clear all", () => clearAll());
		head.append(seg, colors, el("span", "spacer"), undoBtn, redoBtn, clearBtn);

		const stage = el("div", "an-stage");
		const canvas = el("canvas");
		canvas.setAttribute("aria-label", "Screenshot to annotate");
		stage.append(canvas);

		const foot = el("div", "an-foot");
		const note = el("textarea");
		note.rows = 2;
		note.placeholder = "Note for Pi (optional)";
		note.setAttribute("aria-label", "Note for Pi");
		const cancel = el("button", "btn secondary", "Cancel");
		cancel.type = "button";
		const add = el("button", "btn", "Add to chat");
		add.type = "button";
		foot.append(note, cancel, add);
		root.append(head, stage, foot);
		$('.tab-panel[data-panel="browser"]').append(root);
		crust.browser.hide(true, "annotate");

		const s = (ov = { root, canvas, tool: "pen", color: COLORS[0].token, shapes: [], redo: [], cur: null, img: null, onKey: null, textInput: null, ready: false });
		const toolBtns = new Map();
		for (const t of TOOLS) {
			const b = el("button", "icon");
			b.type = "button";
			b.title = `${t.label} (${t.key.toUpperCase()})`;
			b.setAttribute("aria-label", t.label);
			b.innerHTML = t.icon;
			b.onclick = () => setTool(t.id);
			toolBtns.set(t.id, b);
			seg.append(b);
		}
		const colorBtns = new Map();
		for (const c of COLORS) {
			const b = el("button", "swatch");
			b.type = "button";
			b.style.setProperty("--sw", `var(${c.token})`);
			b.title = c.label;
			b.setAttribute("aria-label", c.label);
			b.onclick = () => setColor(c.token);
			colorBtns.set(c.token, b);
			colors.append(b);
		}
		function setTool(id) {
			commitText();
			s.tool = id;
			for (const [k, b] of toolBtns) b.setAttribute("aria-pressed", String(k === id));
			canvas.style.cursor = id === "text" ? "text" : "crosshair";
		}
		function setColor(token) {
			s.color = token;
			for (const [k, b] of colorBtns) b.setAttribute("aria-pressed", String(k === token));
		}
		function paintButtons() {
			undoBtn.disabled = !s.shapes.length;
			redoBtn.disabled = !s.redo.length;
			clearBtn.disabled = !s.shapes.length;
		}
		function undo() {
			commitText();
			const x = s.shapes.pop();
			if (x) s.redo.push(x);
			draw();
		}
		function redo() {
			const x = s.redo.pop();
			if (x) s.shapes.push(x);
			draw();
		}
		function clearAll() {
			commitText();
			s.shapes = [];
			s.redo = [];
			draw();
		}

		const lw = () => Math.max(3, Math.round(canvas.width / 320));
		// Token colours are resolved once per draw (each lookup goes through the DOM and a canvas pixel), not once per shape.
		let colorCache = new Map();
		const colorOf = (token) => {
			if (!colorCache.has(token)) colorCache.set(token, D.tokenColor(token));
			return colorCache.get(token);
		};
		function drawShape(g, sh) {
			g.strokeStyle = g.fillStyle = colorOf(sh.color);
			g.lineWidth = lw();
			g.lineCap = g.lineJoin = "round";
			if (sh.t === "pen") {
				g.beginPath();
				sh.pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
				if (sh.pts.length === 1) g.lineTo(sh.pts[0][0] + 0.01, sh.pts[0][1]);
				g.stroke();
			} else if (sh.t === "box") {
				g.strokeRect(sh.a[0], sh.a[1], sh.b[0] - sh.a[0], sh.b[1] - sh.a[1]);
			} else if (sh.t === "arrow") {
				const [x1, y1] = sh.a;
				const [x2, y2] = sh.b;
				const ang = Math.atan2(y2 - y1, x2 - x1);
				const head = lw() * 5;
				g.beginPath();
				g.moveTo(x1, y1);
				g.lineTo(x2, y2);
				g.moveTo(x2 - head * Math.cos(ang - 0.45), y2 - head * Math.sin(ang - 0.45));
				g.lineTo(x2, y2);
				g.lineTo(x2 - head * Math.cos(ang + 0.45), y2 - head * Math.sin(ang + 0.45));
				g.stroke();
			} else if (sh.t === "text") {
				g.font = `600 ${lw() * 6}px ${getComputedStyle(document.body).fontFamily}`;
				g.textBaseline = "top";
				sh.s.split("\n").forEach((line, i) => g.fillText(line, sh.p[0], sh.p[1] + i * lw() * 7.5));
			}
		}
		function draw(g = canvas.getContext("2d"), withCurrent = true) {
			if (!s.img) return;
			colorCache = new Map();
			g.clearRect(0, 0, canvas.width, canvas.height);
			g.drawImage(s.img, 0, 0);
			for (const sh of s.shapes) drawShape(g, sh);
			if (withCurrent && s.cur) drawShape(g, s.cur);
			paintButtons();
		}
		s.draw = draw;
		s.undo = undo;
		s.redoFn = redo;

		const pos = (e) => {
			const r = canvas.getBoundingClientRect();
			return [Math.round(((e.clientX - r.left) * canvas.width) / r.width), Math.round(((e.clientY - r.top) * canvas.height) / r.height)];
		};
		function commitText() {
			const ti = s.textInput;
			if (!ti) return;
			s.textInput = null;
			const v = ti.input.value.trim();
			ti.input.remove();
			if (v) {
				s.shapes.push({ t: "text", p: ti.p, s: v, color: s.color });
				s.redo = [];
				draw();
			}
		}
		canvas.addEventListener("pointerdown", (e) => {
			if (e.button !== 0 || !s.img) return;
			const p = pos(e);
			if (s.tool === "text") {
				commitText();
				const r = canvas.getBoundingClientRect();
				const sr = stage.getBoundingClientRect();
				const input = el("input", "an-text");
				input.setAttribute("aria-label", "Annotation text");
				input.style.left = `${e.clientX - sr.left}px`;
				input.style.top = `${e.clientY - sr.top}px`;
				input.style.color = `var(${s.color})`;
				input.style.fontSize = `${(lw() * 6 * r.width) / canvas.width}px`;
				input.addEventListener("keydown", (ev) => {
					ev.stopPropagation();
					if (ev.key === "Enter") commitText();
					if (ev.key === "Escape") {
						s.textInput = null;
						input.remove();
					}
				});
				input.addEventListener("blur", () => commitText());
				stage.append(input);
				s.textInput = { input, p };
				setTimeout(() => input.focus(), 0);
				e.preventDefault();
				return;
			}
			canvas.setPointerCapture(e.pointerId);
			s.cur = s.tool === "pen" ? { t: "pen", pts: [p], color: s.color } : { t: s.tool, a: p, b: p, color: s.color };
			draw();
		});
		canvas.addEventListener("pointermove", (e) => {
			if (!s.cur) return;
			const p = pos(e);
			if (s.cur.t === "pen") s.cur.pts.push(p);
			else s.cur.b = p;
			draw();
		});
		const end = () => {
			if (!s.cur) return;
			const c = s.cur;
			s.cur = null;
			const tiny = c.t !== "pen" && Math.abs(c.a[0] - c.b[0]) + Math.abs(c.a[1] - c.b[1]) < 4;
			if (!tiny) {
				s.shapes.push(c);
				s.redo = [];
			}
			draw();
		};
		canvas.addEventListener("pointerup", end);
		canvas.addEventListener("pointercancel", end);

		cancel.onclick = () => close();
		add.onclick = async () => {
			commitText();
			const out = document.createElement("canvas");
			out.width = canvas.width;
			out.height = canvas.height;
			draw(out.getContext("2d"), false);
			const file = D.dataUrlToFile(out.toDataURL("image/png"), "annotated-screenshot.png");
			const text = note.value.trim();
			close();
			await D.sendToChat([file], text ? `Notes on the annotated screenshot: ${text}` : "The annotated screenshot marks what I mean.");
		};
		s.onKey = (e) => {
			// A dialog on top (e.g. a confirm) owns the keyboard: Esc closes that, not the overlay.
			if (document.querySelector("#modal-backdrop:not([hidden])")) return;
			if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				return close();
			}
			const inField = /^(INPUT|TEXTAREA)$/.test(e.target?.tagName || "");
			if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "z" && !inField) {
				e.preventDefault();
				e.stopPropagation();
				return e.shiftKey ? redo() : undo();
			}
			if (inField || e.metaKey || e.ctrlKey || e.altKey) return;
			const t = TOOLS.find((x) => x.key === e.key.toLowerCase());
			if (t) {
				e.preventDefault();
				setTool(t.id);
			}
		};
		addEventListener("keydown", s.onKey, true);
		setTool("pen");
		setColor(COLORS[0].token);
		paintButtons();

		const img = new Image();
		img.onload = () => {
			s.img = img;
			canvas.width = img.naturalWidth;
			canvas.height = img.naturalHeight;
			draw();
			s.ready = true;
		};
		img.src = dataUrl;
		setTimeout(() => toolBtns.get("pen").focus(), 0);
		return s;
	}

	function close() {
		if (!ov) return;
		const s = ov;
		ov = null;
		removeEventListener("keydown", s.onKey, true);
		s.root.remove();
		crust.browser.hide(false, "annotate");
	}

	onThemeChange(() => ov?.draw());
	onCrust("tab:changed", (name) => {
		if (ov && name !== "browser") close();
	});

	let busy = false;
	async function start() {
		if (busy || ov) return;
		busy = true;
		try {
			if (activeTab !== "browser") {
				switchTab("browser");
				await new Promise((r) => setTimeout(r, 150));
			}
			const r = await crust.snap.live({ kind: "design" });
			if (!r.ok) return toast(r.error || "Couldn't capture the page", "error");
			const url = await crust.snap.get(r.entry.id);
			if (!url) return toast("The screenshot is no longer available", "error");
			open(url);
		} finally {
			busy = false;
		}
	}

	$("#annotate-btn").addEventListener("click", start);
	const prev = window.crustPaletteActions;
	window.crustPaletteActions = () => [...(prev?.() || []), { label: "Annotate a screenshot of the page", desc: "pen, arrow, box, text", run: start }];

	selftestSteps.push(async ({ snap, wait }) => {
		await crust.snap.selftestLoad('<body style="margin:0;font:600 36px sans-serif;background:#2a6;color:#fff;display:grid;place-items:center;height:100vh">Annotate me</body>');
		switchTab("browser");
		await wait(700);
		await start();
		for (let i = 0; i < 20 && !ov?.ready; i++) await wait(100);
		const size = window.crustAnnotate.size();
		if (!size) return console.error("SELFTEST annotate: overlay did not open -> MISMATCH");
		const [w, h] = size;
		window.crustAnnotate.addShapes([
			{ t: "box", a: [w * 0.3, h * 0.3], b: [w * 0.7, h * 0.55], color: "--err" },
			{ t: "arrow", a: [w * 0.15, h * 0.8], b: [w * 0.4, h * 0.58], color: "--warn" },
			{ t: "pen", pts: [[w * 0.6, h * 0.7], [w * 0.65, h * 0.75], [w * 0.72, h * 0.68], [w * 0.8, h * 0.78]], color: "--accent" },
			{ t: "text", p: [w * 0.12, h * 0.85], s: "Make this bigger", color: "--ok" },
		]);
		await wait(300);
		const st = await crust.selftest.bounds();
		console.error(`SELFTEST annotate: ${w}x${h}, browser view hidden=${!st.visible} (${st.hidden}) -> ${st.visible ? "MISMATCH" : "OK"}`);
		await snap("annotate");
		const was = themeSetting();
		setTheme(currentTheme() === "dark" ? "light" : "dark");
		await wait(500);
		await snap(`annotate-${currentTheme()}`);
		setTheme(was);
		await wait(300);
		const before = active?.picks.length || 0;
		$(".annotate .an-foot .btn:not(.secondary)").click();
		await wait(800);
		console.error(`SELFTEST annotate add to chat: picks ${before} -> ${active?.picks.length}, overlay closed=${!ov} -> ${active?.picks.length === before + 1 && !ov ? "OK" : "MISMATCH"}`);
		await snap("annotate-added");
		if (active) {
			active.picks.length = before;
			renderPicks();
		}
		const st2 = await crust.selftest.bounds();
		console.error(`SELFTEST annotate closed: browser view visible=${st2.visible} -> ${st2.visible ? "OK" : "MISMATCH"}`);
	});

	window.crustAnnotate = {
		start,
		close,
		isOpen: () => !!ov,
		// For the self-test: add finished shapes (image pixel coordinates).
		addShapes(list) {
			if (!ov) return;
			ov.shapes.push(...list);
			ov.draw();
		},
		size: () => (ov?.img ? [ov.canvas.width, ov.canvas.height] : null),
		ready: () => !!ov?.ready,
	};
})();
