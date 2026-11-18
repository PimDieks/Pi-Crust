// Design tab, "Tokens" view: the theme tokens of the page in the Viewer tab (CSS custom properties and the MUI theme) as
// swatches with contrast, spacing bars, radii and type specimens, with an optional comparison against Figma variables.
// Tokens can also come from a JSON file ("designTokensFile" in settings.json, relative to the repo).
"use strict";

(() => {
	const D = window.crustDesign;
	const TM = window.TokenMatch;
	const TS = window.TokenSearch;
	let ui = null;
	let model = null; // { source, colors, spacing, radii, typography, bg }
	let busy = false;
	let compareRows = null;
	let query = "";

	const num = (v) => TM.toPx(v) ?? 0;
	const byPx = (a, b) => num(a.value) - num(b.value);
	const RADIUS = /radius|round/i;
	const FONTISH = /font|text|line|letter/i;

	function fromPage(data) {
		const lens = data.vars.filter((v) => v.kind === "length");
		return {
			source: `Page ${data.url.replace(/^https?:\/\//, "").slice(0, 60)}: ${data.vars.length} CSS variables${data.mui ? ", MUI theme found" : ""}`,
			colors: [...data.vars.filter((v) => v.kind === "color"), ...(data.mui?.palette || [])],
			spacing: [...lens.filter((v) => !RADIUS.test(v.name) && !FONTISH.test(v.name)), ...(data.mui?.spacing || [])].sort(byPx),
			radii: [...lens.filter((v) => RADIUS.test(v.name)), ...(data.mui?.radius || [])].sort(byPx),
			typography: data.mui?.typography || [],
			bg: TM.normalizeColor(data.background),
		};
	}

	function fromFile(file, t) {
		return { source: `Tokens file ${file}`, colors: t.colors, spacing: t.spacing.sort(byPx), radii: t.radii.sort(byPx), typography: t.typography, bg: null };
	}

	async function read(quiet) {
		if (busy || !ui) return;
		busy = true;
		ui.read.setAttribute("aria-busy", "true");
		try {
			const r = await crust.design.tokens();
			let err = r.error;
			if (r.ok) {
				const m = fromPage(r.data);
				if (m.colors.length || m.spacing.length || m.radii.length || m.typography.length) {
					model = m;
					compareRows = null;
					return render();
				}
				err = "No theme tokens found on the page (no CSS custom properties on :root, no MUI theme).";
			}
			const f = await crust.design.tokensFile();
			if (f.tokens) {
				model = fromFile(f.file, f.tokens);
				compareRows = null;
				return render();
			}
			if (f.error) err = f.error;
			model = null;
			render(err);
			if (!quiet) toast(err, "warning");
		} finally {
			busy = false;
			ui.read.removeAttribute("aria-busy");
		}
	}

	// --- rendering -------------------------------------------------------------------------------
	const section = (title, count) => {
		const s = el("section", "dt-section");
		s.append(el("h3", "dt-title", `${title} ${count}`));
		return s;
	};

	// Colour families: "color-north-sea-80-a10" → family "color-north-sea", step 80, suffix "a10". Families keep the order
	// they first appear in; within one, plain steps come first (by step), then variants (by step, then suffix).
	// Families with a single token go together in "Other".
	function parseColorName(name) {
		const n = name.replace(/^--/, "");
		let m = n.match(/^(.*?)[-.](\d+(?:\.\d+)?)(?:[-.](.*))?$/);
		if (m && m[1]) return { family: m[1], step: Number(m[2]), suffix: m[3] || "" };
		m = n.match(/^(.*)[-.]([^-.]+)$/);
		return m ? { family: m[1], step: null, suffix: m[2] } : { family: n, step: null, suffix: "" };
	}

	function colorGroups(colors) {
		const fams = new Map();
		for (const c of colors) {
			const p = parseColorName(c.name);
			if (!fams.has(p.family)) fams.set(p.family, []);
			fams.get(p.family).push({ c, p });
		}
		const cmp = (a, b) =>
			(a.p.step == null) - (b.p.step == null) ||
			!!a.p.suffix - !!b.p.suffix ||
			(a.p.step ?? 0) - (b.p.step ?? 0) ||
			a.p.suffix.localeCompare(b.p.suffix, undefined, { numeric: true });
		const groups = [];
		const other = [];
		for (const [family, list] of fams) {
			if (list.length < 2) {
				other.push(...list.map(({ c }) => ({ c, label: c.name.replace(/^--/, "") })));
				continue;
			}
			list.sort(cmp);
			groups.push({ family, items: list.map(({ c }) => ({ c, label: c.name.replace(/^--/, "").slice(family.length + 1) })) });
		}
		if (other.length) groups.push({ family: null, items: other });
		return groups;
	}

	// Click copies the token name, ⌥/⇧-click (or Enter / ⇧Enter) the CSS form: var(--x) or the theme path.
	const isTheme = () => !!model && model.source.startsWith("Page");
	const cssOf = (name) => TS.cssForm(name, isTheme());
	async function copyToken(name, css) {
		const text = css ? cssOf(name) : name;
		try {
			await crust.clipboard.write(text);
			toast(`Copied ${text}`, "info");
		} catch (e) {
			toast(`Copy failed: ${e.message || e}`, "error");
		}
	}
	function copyable(node, name) {
		node.classList.add("dt-copy");
		node.tabIndex = 0;
		node.setAttribute("role", "button");
		node.title = `${node.title ? `${node.title}\n` : ""}Click: copy ${name}. ${keyLabel("⌥-click")}: copy ${cssOf(name)}`;
		node.onclick = (e) => copyToken(name, e.altKey || e.shiftKey);
		node.onkeydown = (e) => {
			if (e.key !== "Enter" && e.key !== " ") return;
			e.preventDefault();
			copyToken(name, e.shiftKey);
		};
		return node;
	}

	function searchTokens() {
		if (!model) return [];
		const typo = model.typography.filter((t) => t.fontSize != null).map((t) => ({ name: t.name, value: String(t.fontSize) }));
		const tag = (list, group) => list.map((t) => ({ name: t.name, value: t.value, group }));
		return [...tag(model.colors, "colour"), ...tag(model.spacing, "spacing"), ...tag(model.radii, "radius"), ...tag(typo, "font size")];
	}

	function hitRow(t) {
		const row = el("div", "dt-hit");
		if (t.group === "colour") {
			const chip = el("span", "dt-dot");
			chip.style.background = t.value;
			row.append(chip);
		}
		const label = t.label ? el("span", `dt-delta${t.label === "exact" ? " exact" : ""}`, t.label) : null;
		const css = el("button", "btn secondary dt-css", "CSS");
		css.type = "button";
		css.title = `Copy ${cssOf(t.name)}`;
		css.onclick = (e) => {
			e.stopPropagation();
			copyToken(t.name, true);
		};
		row.append(el("span", "dt-name", t.name.replace(/^--/, "")), el("span", "dt-val", `${t.value} · ${t.group}`));
		if (label) row.append(label);
		row.append(css);
		return copyable(row, t.name);
	}

	function renderResults() {
		const r = TS.search(query, searchTokens());
		const frag = document.createDocumentFragment();
		const block = (title, list) => {
			if (!list.length) return;
			const s = section(title, list.length);
			const box = el("div", "dt-hits");
			for (const t of list) box.append(hitRow(t));
			s.append(box);
			frag.append(s);
		};
		if (r.kind === "color" || r.kind === "length") block(r.kind === "color" ? "Exact colour matches" : "Exact length matches", r.exact);
		block(r.kind === "name" ? "Names" : "Name matches", r.names);
		block("Nearest", r.near);
		if (!frag.childNodes.length) frag.append(D.empty(`No token matches "${query.trim()}".`));
		return frag;
	}

	function colorTile(c, label) {
		const tile = el("div", "dt-sw");
		tile.title = `${c.name}\n${c.value}`;
		const chip = el("div", "dt-chip");
		chip.style.background = c.value;
		const n = el("div", "dt-name", label);
		const v = el("div", "dt-val", c.value);
		const col = TM.normalizeColor(c.value);
		if (col && model.bg && col.a > 0) {
			const ratio = TM.contrast(col, model.bg);
			const badge = el("span", `dt-ratio ${ratio >= 4.5 ? "ok" : ratio >= 3 ? "warn" : "low"}`, `${ratio}:1`);
			badge.title = "Contrast against the page background (WCAG: 4.5 for text, 3 for large text)";
			v.append(badge);
		}
		tile.append(chip, n, v);
		return copyable(tile, c.name);
	}

	function render(emptyText) {
		const body = ui.body;
		body.replaceChildren();
		ui.meta.textContent = model ? model.source : "";
		ui.meta.hidden = !model;
		ui.compare.disabled = !model;
		if (!model) {
			body.append(D.empty(emptyText || "Open your app in the Viewer tab and choose Read tokens from page. No theme tokens in the page? Set designTokensFile in settings.json to a tokens JSON file (the last button writes one with Pi)."));
			return;
		}
		if (query.trim()) {
			body.append(renderResults());
			return;
		}
		if (compareRows) body.append(renderCompare());
		if (model.colors.length) {
			const s = section("Colours", model.colors.length);
			for (const g of colorGroups(model.colors)) {
				s.append(el("h4", "dt-group", g.family || "Other"));
				const grid = el("div", "dt-swatches");
				for (const { c, label } of g.items) grid.append(colorTile(c, label));
				s.append(grid);
			}
			body.append(s);
		}
		if (model.spacing.length) {
			const s = section("Spacing", model.spacing.length);
			const list = el("div", "dt-bars");
			const max = Math.max(...model.spacing.map((x) => num(x.value)), 1);
			for (const t of model.spacing) {
				const row = el("div", "dt-bar-row");
				const bar = el("span", "dt-bar");
				bar.style.width = `${Math.max(2, (num(t.value) / max) * 100)}%`;
				const track = el("span", "dt-track");
				track.append(bar);
				row.append(el("span", "dt-name", t.name.replace(/^--/, "")), track, el("span", "dt-val", t.value));
				copyable(row, t.name);
				list.append(row);
			}
			s.append(list);
			body.append(s);
		}
		if (model.radii.length) {
			const s = section("Radii", model.radii.length);
			const grid = el("div", "dt-swatches");
			for (const t of model.radii) {
				const tile = el("div", "dt-sw");
				const chip = el("div", "dt-chip dt-radius");
				chip.style.borderRadius = t.value;
				tile.append(chip, el("div", "dt-name", t.name.replace(/^--/, "")), el("div", "dt-val", t.value));
				grid.append(copyable(tile, t.name));
			}
			s.append(grid);
			body.append(s);
		}
		if (model.typography.length) {
			const s = section("Typography", model.typography.length);
			for (const t of model.typography) {
				const row = el("div", "dt-type");
				const sample = el("div", "dt-sample", "The quick brown fox jumps over the lazy dog");
				sample.style.fontSize = String(t.fontSize);
				sample.style.fontWeight = String(t.fontWeight || 400);
				if (t.lineHeight) sample.style.lineHeight = String(t.lineHeight);
				if (t.fontFamily) sample.style.fontFamily = String(t.fontFamily);
				row.append(el("div", "dt-name", t.name), sample, el("div", "dt-val", [t.fontSize, t.fontWeight, t.lineHeight].filter((x) => x != null && x !== "").join(" / ")));
				s.append(copyable(row, t.name));
			}
			body.append(s);
		}
	}

	// --- comparison with Figma variables ---------------------------------------------------------
	const normName = (s) => String(s).toLowerCase().replace(/^--/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
	const sameValue = (a, b) => {
		const ca = TM.normalizeColor(a);
		const cb = TM.normalizeColor(b);
		if (ca && cb) return ca.r === cb.r && ca.g === cb.g && ca.b === cb.b && Math.abs(ca.a - cb.a) < 0.02;
		const la = TM.toPx(a);
		const lb = TM.toPx(b);
		if (la != null && lb != null) return Math.abs(la - lb) < 0.01;
		return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
	};

	// rows: { status: "same"|"diff"|"code"|"figma", code?, figma?, codeValue?, figmaValue? }
	function compareTokens(code, figma) {
		const f = Object.entries(figma).map(([name, value]) => ({ name, value: String(value), n: normName(name), used: false }));
		const rows = [];
		for (const c of code) {
			const n = normName(c.name);
			const hit = f.find((x) => !x.used && x.n === n) || f.find((x) => !x.used && n.length >= 3 && (x.n.endsWith(`-${n}`) || n.endsWith(`-${x.n}`)));
			if (!hit) {
				rows.push({ status: "code", code: c.name, codeValue: c.value });
				continue;
			}
			hit.used = true;
			rows.push({ status: sameValue(c.value, hit.value) ? "same" : "diff", code: c.name, codeValue: c.value, figma: hit.name, figmaValue: hit.value });
		}
		for (const x of f) if (!x.used) rows.push({ status: "figma", figma: x.name, figmaValue: x.value });
		const order = { diff: 0, code: 1, figma: 2, same: 3 };
		return rows.sort((a, b) => order[a.status] - order[b.status]);
	}

	const LABEL = { same: ["✓", "same"], diff: ["≠", "different"], code: ["code", "only in code"], figma: ["Figma", "only in Figma"] };
	function renderCompare() {
		const s = section("Figma variables", compareRows.length);
		const counts = {};
		for (const r of compareRows) counts[r.status] = (counts[r.status] || 0) + 1;
		s.append(el("p", "dt-summary muted", `${counts.same || 0} same, ${counts.diff || 0} different, ${counts.code || 0} only in code, ${counts.figma || 0} only in Figma`));
		const table = el("div", "dt-table");
		table.setAttribute("role", "table");
		for (const r of compareRows) {
			const row = el("div", "dt-row");
			row.setAttribute("role", "row");
			const st = el("span", `dt-status ${r.status}`, LABEL[r.status][0]);
			st.title = LABEL[r.status][1];
			st.setAttribute("aria-label", LABEL[r.status][1]);
			const cell = (name, value) => {
				const c = el("span", "dt-cell");
				if (name) c.append(el("span", "dt-name", name.replace(/^--/, "")), el("span", "dt-val", value));
				return c;
			};
			row.append(st, cell(r.code, r.codeValue), cell(r.figma, r.figmaValue));
			table.append(row);
		}
		s.append(table);
		return s;
	}

	async function compareWithFigma() {
		if (!model) return;
		ui.compare.disabled = true;
		ui.compare.setAttribute("aria-busy", "true");
		try {
			const r = await crust.design.figmaVariables();
			if (r.error) {
				window.crustFigma?.recheck();
				return toast(r.error, "error");
			}
			if (!Object.keys(r.defs).length) return toast("The selection in Figma uses no variables. Select a frame that does.", "warning");
			const code = [...model.colors, ...model.spacing, ...model.radii];
			compareRows = compareTokens(code, r.defs);
			render();
		} catch (e) {
			toast(`Figma failed: ${e.message || e}. See Figma status above.`, "error");
			window.crustFigma?.recheck();
		} finally {
			ui.compare.disabled = !model;
			ui.compare.removeAttribute("aria-busy");
		}
	}

	function askExport() {
		if (!active) return toast("Open a chat first", "warning");
		const input = $("#input");
		const text =
			"Export this project's theme (the MUI theme or CSS custom properties) as a design tokens JSON file at `design-tokens.json` with the groups `colors`, `spacing`, `radii` and `typography` (name → value; typography entries with fontSize, fontWeight, lineHeight, fontFamily). Resolve values to concrete colours and px. Then tell me the path so I can set `designTokensFile` in Pi Crust's settings.json.";
		input.value = input.value ? `${input.value}\n${text}` : text;
		input.dispatchEvent(new Event("input", { bubbles: true }));
		input.focus();
		toast("Added to the chat input. Review it and press Send.", "info");
	}

	function mount(host) {
		const bar = el("div", "dv-toolbar");
		const mk = (cls, text, title, fn) => {
			const b = el("button", cls, text);
			b.type = "button";
			b.title = title;
			b.onclick = fn;
			return b;
		};
		const readBtn = mk("btn secondary", "Read tokens from page", "Read the tokens of the page in the Viewer tab", () => read(false));
		const compareBtn = mk("btn secondary", "Compare with Figma variables", "Compare with the variables used by the frame selected in Figma desktop", compareWithFigma);
		compareBtn.disabled = true;
		const exportBtn = mk("btn", `Ask ${agentLabel()} to export tokens JSON`, "Put a request for a design-tokens.json export in the chat input", askExport);
		bar.append(readBtn, compareBtn, el("span", "spacer"), exportBtn);
		const search = el("input", "dt-search");
		search.type = "search";
		search.placeholder = "Find a token: name, #1a73e8, rgb(…), 12px, 0.75rem";
		search.setAttribute("aria-label", "Find a token by name or value");
		search.oninput = () => {
			query = search.value;
			render();
		};
		search.onkeydown = (e) => {
			if (e.key === "Escape" && search.value) {
				e.stopPropagation();
				search.value = query = "";
				render();
			}
		};
		const searchBar = el("div", "dt-searchbar");
		searchBar.append(search);
		const meta = el("div", "dv-meta");
		const body = el("div", "dt-body dv-stage");
		host.append(searchBar, bar, meta, body);
		ui = { read: readBtn, compare: compareBtn, meta, body, search };
		render();
	}

	registerDesignView({ id: "tokens", label: "Tokens", mount, show: () => !model && read(true) });

	// For the self-test.
	// Open Design > Tokens with the search focused (palette action "Find token…").
	function findToken() {
		switchTab("design");
		D.select("tokens");
		setTimeout(() => {
			ui?.search.focus();
			ui?.search.select();
		}, 50);
	}
	const prevActions = window.crustPaletteActions;
	window.crustPaletteActions = () => [...(prevActions?.() || []), { label: "Find token…", desc: "Design > Tokens: search by name or value", run: findToken }];

	D.tokens = { read, state: () => model, compareTokens, normName };

	selftestSteps.push(async ({ snap, wait }) => {
		const page = `<style>:root{--brand:#ff0000;--ink:#222222;--paper:#f7f7f7;--space-2:8px;--space-4:16px;--radius-sm:4px;--radius-md:8px}
			body{margin:0;background:#f7f7f7;font:14px sans-serif}
			#t{padding:8px;border-radius:4px;background:#ff0000;color:#123456;margin:20px}</style>
			<div id="t">Token target</div>`;
		await crust.snap.selftestLoad(page);
		switchTab("design");
		D.select("tokens");
		await wait(300);
		await read(true);
		await wait(500);
		const m = model;
		console.error(`SELFTEST tokens: colors=${m?.colors.length} spacing=${m?.spacing.length} radii=${m?.radii.length} -> ${m && m.colors.length === 3 && m.spacing.length === 2 && m.radii.length === 2 ? "OK" : "MISMATCH"}`);
		const ins = await crust.design.inspect("#t");
		const items = ins.check?.items || [];
		const bg = items.find((i) => i.prop === "background-color");
		const fg = items.find((i) => i.prop === "color");
		console.error(`SELFTEST token check: bg=${bg?.token} color=${fg?.token || "hard-coded"} nearest=${fg?.nearest} padding=${items.find((i) => i.prop === "padding")?.token} -> ${bg?.token === "--brand" && !fg?.token && items.find((i) => i.prop === "padding")?.token === "--space-2" ? "OK" : "MISMATCH"}`);
		await crust.design.untag();
		compareRows = compareTokens([...m.colors, ...m.spacing, ...m.radii], { "color/brand": "#ff0000", "color/ink": "#000000", "space/2": "8", "radius/xl": "24" });
		render();
		await wait(300);
		const st = compareRows.map((r) => r.status).join(",");
		console.error(`SELFTEST figma compare: ${st} -> ${st.startsWith("diff") && st.includes("same") && st.includes("figma") && st.includes("code") ? "OK" : "MISMATCH"}`);
		await snap("tokens");
		const was = themeSetting();
		setTheme(currentTheme() === "dark" ? "light" : "dark");
		await wait(500);
		await snap(`tokens-${currentTheme()}`);
		setTheme(was);
		await wait(300);
		compareRows = null;
	});
})();
