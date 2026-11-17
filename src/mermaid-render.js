// Mermaid diagrams in answers: ```mermaid blocks become sanitized SVG, coloured from the app's CSS tokens.
// mermaid.min.js is loaded lazily on first use. The original code stays available behind a "Code" toggle.
"use strict";

(() => {
	const SRC = "../node_modules/mermaid/dist/mermaid.min.js";
	const SVG = "http://www.w3.org/2000/svg";
	const cache = new Map(); // theme + source -> sanitized SVG string
	let loading = null;
	let counter = 0;
	let queue = Promise.resolve();

	function load() {
		if (window.mermaid) return Promise.resolve(window.mermaid);
		loading ||= new Promise((resolve, reject) => {
			const s = document.createElement("script");
			s.src = SRC;
			s.onload = () => resolve(window.mermaid);
			s.onerror = () => {
				loading = null;
				reject(new Error("Could not load Mermaid"));
			};
			document.head.append(s);
		});
		return loading;
	}

	// Computed CSS colours can be color(srgb ...) (color-mix): resolve to plain rgb() through a canvas.
	const ctx2d = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
	function token(name) {
		const probe = document.createElement("span");
		probe.style.color = `var(${name})`;
		probe.style.display = "none";
		document.body.append(probe);
		const raw = getComputedStyle(probe).color;
		probe.remove();
		ctx2d.clearRect(0, 0, 1, 1);
		ctx2d.fillStyle = raw;
		ctx2d.fillRect(0, 0, 1, 1);
		const [r, g, b, a] = ctx2d.getImageData(0, 0, 1, 1).data;
		return a === 255 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(3)})`;
	}

	function themeVariables() {
		const root = getComputedStyle(document.documentElement);
		const t = {
			panel: token("--panel"),
			panel2: token("--panel-2"),
			panel3: token("--panel-3"),
			border: token("--border"),
			softer: token("--borders-softer"),
			text: token("--text"),
			muted: token("--muted"),
			accent: token("--accent"),
			noteBg: token("--fills-minor-muted"),
			noteText: token("--text-minor"),
			errBg: token("--fills-error-muted"),
			errText: token("--text-error"),
		};
		return {
			darkMode: currentTheme() === "dark",
			background: t.panel,
			fontFamily: root.getPropertyValue("--font").trim() || "sans-serif",
			fontSize: root.getPropertyValue("--fs-sm").trim() || "12px",
			primaryColor: t.panel3,
			primaryTextColor: t.text,
			primaryBorderColor: t.softer,
			secondaryColor: t.panel2,
			secondaryTextColor: t.text,
			secondaryBorderColor: t.border,
			tertiaryColor: t.panel2,
			tertiaryTextColor: t.text,
			tertiaryBorderColor: t.border,
			lineColor: t.muted,
			textColor: t.text,
			mainBkg: t.panel3,
			nodeBorder: t.softer,
			nodeTextColor: t.text,
			clusterBkg: t.panel2,
			clusterBorder: t.border,
			titleColor: t.text,
			edgeLabelBackground: t.panel,
			noteBkgColor: t.noteBg,
			noteTextColor: t.noteText,
			noteBorderColor: t.border,
			actorBkg: t.panel3,
			actorBorder: t.softer,
			actorTextColor: t.text,
			actorLineColor: t.muted,
			signalColor: t.muted,
			signalTextColor: t.text,
			labelBoxBkgColor: t.panel2,
			labelBoxBorderColor: t.border,
			labelTextColor: t.text,
			loopTextColor: t.text,
			activationBkgColor: t.panel3,
			activationBorderColor: t.softer,
			sequenceNumberColor: t.panel,
			altBackground: t.panel2,
			errorBkgColor: t.errBg,
			errorTextColor: t.errText,
			pie1: t.accent,
			git0: t.accent,
		};
	}

	async function toSvg(source) {
		const theme = currentTheme();
		const key = `${theme}\0${source}`;
		if (!cache.has(key)) {
			const mermaid = await load();
			const job = queue.then(async () => {
				mermaid.initialize({ startOnLoad: false, securityLevel: "strict", secure: ["secure", "securityLevel", "startOnLoad", "maxTextSize", "themeCSS", "themeVariables", "fontFamily", "htmlLabels", "flowchart"], theme: "base", themeVariables: themeVariables(), htmlLabels: false, flowchart: { htmlLabels: false }, fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--font") });
				const id = `mermaid-${++counter}`;
				// Measured in an off-screen box of our own (laid out, but invisible and out of the way).
				const scratch = el("div", "mermaid-scratch");
				document.body.append(scratch);
				try {
					return (await mermaid.render(id, source, scratch)).svg;
				} finally {
					scratch.remove();
					document.getElementById(`d${id}`)?.remove(); // mermaid leaves its scratch node behind on errors
				}
			});
			queue = job.catch(() => {}); // one failing diagram must not block the next
			const svg = await job;
			cache.set(key, DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } }));
			if (cache.size > 60) cache.delete(cache.keys().next().value);
		}
		return fresh(cache.get(key));
	}

	// A new DOM per use, with its own ids: the same diagram twice on a page would otherwise share ids, so url(#marker),
	// href="#…" and the "#mermaid-N" selectors of the inline <style> would point at the wrong copy.
	function fresh(svg) {
		const ids = [...new Set([...svg.matchAll(/(?<=\s)id="([^"]+)"/g)].map((m) => m[1]))].sort((a, b) => b.length - a.length);
		if (ids.length) {
			const suffix = `-c${++counter}`;
			const alt = ids.map((i) => i.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
			svg = svg
				.replace(new RegExp(`(?<=\\s)id="(${alt})"`, "g"), (_m, i) => `id="${i}${suffix}"`)
				.replace(new RegExp(`#(${alt})(?![\\w-])`, "g"), (_m, i) => `#${i}${suffix}`);
		}
		const t = document.createElement("template");
		t.innerHTML = svg;
		return t.content;
	}

	function codeIcon() {
		const s = document.createElementNS(SVG, "svg");
		s.setAttribute("viewBox", "0 0 16 16");
		s.setAttribute("aria-hidden", "true");
		s.setAttribute("fill", "none");
		s.setAttribute("stroke", "currentColor");
		s.setAttribute("stroke-width", "1.4");
		s.setAttribute("stroke-linecap", "round");
		s.setAttribute("stroke-linejoin", "round");
		const p = document.createElementNS(SVG, "path");
		p.setAttribute("d", "M6 5L3 8l3 3M10 5l3 3-3 3");
		s.append(p);
		return s;
	}

	// Mermaid's own viewBox can be off (cropped diagrams) when measured outside the final layout: refit it to the
	// drawn content once the SVG is visible. Skipped while hidden (getBBox is empty), retried on chat:activated.
	function fit(svg) {
		if (!svg || svg._fitted) return;
		let bb;
		try {
			bb = svg.getBBox();
		} catch {
			return;
		}
		if (!bb.width || !bb.height) return;
		const pad = 8;
		svg.setAttribute("viewBox", `${bb.x - pad} ${bb.y - pad} ${bb.width + 2 * pad} ${bb.height + 2 * pad}`);
		svg.style.maxWidth = `${Math.ceil(bb.width + 2 * pad)}px`;
		svg._fitted = true;
	}

	async function draw(block) {
		const view = block.querySelector(".mermaid-view");
		const note = block.querySelector(".mermaid-note");
		try {
			const svg = await toSvg(block._source);
			view.replaceChildren(svg);
			fit(view.querySelector("svg"));
			note.hidden = true;
			if (!block._showCode) block.classList.remove("failed");
		} catch (e) {
			// Keep the code visible and say why there is no diagram.
			block.classList.add("failed");
			block._showCode = true;
			view.replaceChildren();
			note.textContent = `Could not render the diagram: ${String(e?.message || e).split("\n")[0]}`;
			note.hidden = false;
		}
		sync(block);
	}

	function sync(block) {
		const failed = block.classList.contains("failed");
		block.querySelector("pre").hidden = !block._showCode;
		block.querySelector(".mermaid-view").hidden = failed;
		const btn = block.querySelector(".mermaid-toggle");
		btn.setAttribute("aria-pressed", String(!!block._showCode));
		btn.disabled = failed;
	}

	function enhance(pre) {
		const code = pre.querySelector("code");
		const source = code.textContent.replace(/\n$/, "");
		const block = el("div", "mermaid-block");
		block._source = source;
		block._showCode = false;
		const bar = el("div", "mermaid-bar");
		const toggle = el("button", "icon mermaid-toggle");
		toggle.type = "button";
		toggle.title = "Show the Mermaid code";
		toggle.setAttribute("aria-label", "Show the Mermaid code");
		toggle.append(codeIcon());
		toggle.onclick = () => {
			block._showCode = !block._showCode;
			sync(block);
		};
		bar.append(toggle);
		const view = el("div", "mermaid-view");
		view.setAttribute("role", "img");
		view.setAttribute("aria-label", "Mermaid diagram");
		const note = el("div", "mermaid-note");
		note.hidden = true;
		const wrap = pre.parentElement?.classList.contains("code-block") ? pre.parentElement : pre; // addCodeActions wraps the pre
		wrap.replaceWith(block);
		block.append(bar, view, note, pre);
		pre.hidden = true;
		return block;
	}

	onCrust("text:final", (chat, blockEl) => {
		for (const code of blockEl.querySelectorAll("pre > code.language-mermaid")) {
			const pre = code.parentElement;
			if (!pre.closest(".mermaid-block")) draw(enhance(pre));
		}
	});

	onCrust("chat:activated", (chat) => {
		for (const sv of chat.el.querySelectorAll(".mermaid-view svg")) fit(sv);
	});

	// Re-render for the other theme once the colour cross-fade has finished (tokens are read from computed styles).
	onThemeChange(() => {
		setTimeout(() => {
			for (const b of document.querySelectorAll(".mermaid-block")) draw(b);
		}, 350);
	});

	selftestSteps.push(async ({ snap, wait }) => {
		const host = active.el;
		const raw = "```mermaid\nflowchart LR\n  A[Prompt] --> B{Pi}\n  B -->|edits| C[Files]\n  B -->|asks| D[You]\n  C --> E[Review]\n```";
		const bad = "```mermaid\nnot a diagram at all ((\n```";
		const mk = (r) => {
			const d = el("div", "msg assistant");
			d.append(md(r));
			host.append(d);
			emitCrust("text:final", active, d, r);
			return d;
		};
		const good = mk(raw);
		const broken = mk(bad);
		for (let i = 0; i < 40 && !good.querySelector(".mermaid-view svg"); i++) await wait(250);
		await wait(500);
		const ok = !!good.querySelector(".mermaid-view svg");
		const failed = broken.querySelector(".mermaid-block")?.classList.contains("failed");
		console.error(`SELFTEST mermaid: svg ${ok ? "rendered" : "missing"}, bad source ${failed ? "falls back to code" : "NOT handled"} -> ${ok && failed ? "OK" : "MISMATCH"}`);
		host.scrollTop = host.scrollHeight;
		await wait(200);
		await snap("mermaid");
		const was = themeSetting();
		setTheme(currentTheme() === "dark" ? "light" : "dark");
		await wait(1500);
		await snap(`mermaid-${currentTheme()}`);
		setTheme(was);
		await wait(1200);
		good.remove();
		broken.remove();
	});
})();
