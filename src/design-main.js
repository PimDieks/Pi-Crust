// Main-process side of the Design tab: Figma screenshots (WP5); theme tokens, element inspection for the tweak panel, Figma
// variables and the optional tokens file (WP6).
// register(ctx) wires the IPC handlers.
"use strict";

const figmaError = (e) => require("./figma-status").figmaError(e, { noun: "frame" });

// width / height of a node from get_metadata XML (`<frame id="1:2" name="Card" x=".." y=".." width="390" height="844">`).
function parseFrameSize(xml, nodeId) {
	const tags = [...String(xml || "").matchAll(/<[a-z][\w-]*\s[^>]*>/gi)].map((m) => m[0]);
	const tag = tags.find((t) => nodeId && new RegExp(`\\bid="${nodeId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`).test(t)) || tags.find((t) => /\bwidth="/.test(t));
	if (!tag) return null;
	const num = (k) => Number((new RegExp(`\\b${k}="([\\d.]+)"`).exec(tag) || [])[1]);
	const w = num("width");
	const h = num("height");
	return w > 0 && h > 0 ? { w: Math.round(w), h: Math.round(h) } : null;
}

// A tokens JSON file (designTokensFile setting) -> { colors, spacing, radii, typography: [{ name, value | fontSize… }] }.
// Accepts { colors: { brand: { 500: "#f00" } }, spacing: { 1: "8px" }, radii | radius | borderRadius: {…}, typography: { body: { fontSize… } } };
// values may also be { "$value": … } or { value: … }.
function flattenTokensFile(json) {
	const out = { colors: [], spacing: [], radii: [], typography: [] };
	const val = (v) => (v && typeof v === "object" ? (v.$value ?? v.value) : v);
	const walk = (prefix, o, into, depth = 0) => {
		if (!o || typeof o !== "object" || depth > 4) return;
		for (const [k, v] of Object.entries(o)) {
			const name = prefix ? `${prefix}.${k}` : k;
			const x = val(v);
			if (x != null && typeof x !== "object") into.push({ name, value: String(x) });
			else walk(name, v, into, depth + 1);
		}
	};
	const pick = (...keys) => keys.map((k) => json?.[k]).find((x) => x && typeof x === "object");
	walk("", pick("colors", "color", "palette"), out.colors);
	walk("", pick("spacing", "space"), out.spacing);
	walk("", pick("radii", "radius", "borderRadius"), out.radii);
	for (const [k, v] of Object.entries(pick("typography", "fonts") || {})) {
		if (v && typeof v === "object" && (v.fontSize != null || v.$value?.fontSize != null)) out.typography.push({ name: k, ...(v.$value || v) });
	}
	return out;
}

function register(ctx) {
	const { ipcMain } = ctx;
	const fs = require("node:fs");
	const path = require("node:path");
	const { TOKENS_JS } = require("./page-tokens");
	const pageWc = () => ctx.browserView?.webContents || null;

	// The selected Figma frame as an image, with its size: { dataUrl, frameW, frameH, name, nodeId } | { error }.
	ipcMain.handle("figma:screenshot", async () => {
		try {
			const { callTool, callToolRaw } = require("./figma-mcp");
			const { parseDesignContext } = require("./figma-selection");
			const context = await callTool("get_design_context", { clientLanguages: "typescript", clientFrameworks: "react" });
			const sel = parseDesignContext(context, {});
			if (!sel.rootId) return { error: "Couldn't read the selection from Figma." };
			let size = null;
			try {
				size = parseFrameSize(await callTool("get_metadata", { nodeId: sel.rootId }), sel.rootId);
			} catch {}
			const parts = await callToolRaw("get_screenshot", { nodeId: sel.rootId });
			const img = parts.find((c) => c.type === "image" && c.data);
			if (!img) return { error: "Figma returned no image for the selection." };
			return {
				dataUrl: `data:${img.mimeType || "image/png"};base64,${img.data}`,
				frameW: size?.w || 0,
				frameH: size?.h || 0,
				name: sel.rootName || sel.rootId,
				nodeId: sel.rootId,
			};
		} catch (e) {
			return { error: figmaError(e) };
		}
	});

	// --- theme tokens of the page in the Viewer tab ---------------------------------------------
	// Tweak, tokens and inspection need a web page in the active tab: not an image, not a PDF.
	const noPage = () => {
		const wc = pageWc();
		const url = wc ? wc.getURL() : "";
		if (ctx.browserTab && ctx.browserTab()?.kind !== "page") return true;
		return !wc || !(/^(https?|pi-project):/i.test(url) || (ctx.selftest && /^data:text\/html/i.test(url)));
	};

	ipcMain.handle("design:tokens", async () => {
		if (noPage()) return { error: "The Viewer tab has no page open. Open your app there first." };
		try {
			const wc = pageWc();
			await wc.executeJavaScript(TOKENS_JS, true);
			const top = await wc.executeJavaScript("window.__piTokens.collect(true)", true);
			if (top.vars.length || top.mui) return { ok: true, data: top };
			// Nothing on the top page (e.g. the Storybook manager): try the child frames, such as the preview iframe.
			for (const f of wc.mainFrame.framesInSubtree) {
				if (f === wc.mainFrame || !/^https?:/i.test(f.url)) continue;
				try {
					await f.executeJavaScript(TOKENS_JS, true);
					const d = await f.executeJavaScript("window.__piTokens.collect(true)", true);
					if (d && (d.vars.length || d.mui)) return { ok: true, data: d };
				} catch {}
			}
			return { ok: true, data: top };
		} catch (e) {
			return { error: String((e && e.message) || e) };
		}
	});

	// Marks the element for the tweak panel (data-pi-tweak) and returns its current values and the page's tokens.
	ipcMain.handle("design:inspect", async (_e, selector) => {
		if (noPage()) return { error: "The Viewer tab has no page open." };
		try {
			const wc = pageWc();
			await wc.executeJavaScript(TOKENS_JS, true);
			const r = await wc.executeJavaScript(
				`((sel) => {
					document.querySelectorAll('[data-pi-tweak]').forEach((n) => n.removeAttribute('data-pi-tweak'));
					let el = null;
					try { el = document.querySelector(sel); } catch {}
					if (!el) return null;
					el.setAttribute('data-pi-tweak', '1');
					const cs = getComputedStyle(el);
					const px = (p) => parseFloat(cs.getPropertyValue(p)) || 0;
					return {
						tag: el.localName, display: cs.display,
						padding: ['top', 'right', 'bottom', 'left'].map((s) => px('padding-' + s)),
						gap: px('row-gap'), radius: px('border-top-left-radius'), fontSize: px('font-size'),
						color: cs.color, background: cs.backgroundColor,
						tokens: window.__piTokens.collect(), check: window.__piTokens.check(el),
					};
				})(${JSON.stringify(String(selector || ""))})`,
				true,
			);
			return r ? { ok: true, ...r } : { error: "Couldn't find that element on the page any more." };
		} catch (e) {
			return { error: String((e && e.message) || e) };
		}
	});
	ipcMain.handle("design:untag", async () => {
		if (noPage()) return;
		await pageWc().executeJavaScript("document.querySelectorAll('[data-pi-tweak]').forEach((n) => n.removeAttribute('data-pi-tweak'))", true).catch(() => {});
	});
	// Tweak CSS belongs to the tab it was inserted on. The key the UI holds is "<tab id>|<key>": a removal goes to that tab, never to the
	// active one, and a switch of tab takes it out of the tab being left (and tells the UI to close Tweak), so a tab never keeps it and
	// another tab never gets it.
	const tweakCss = new Map(); // tab id -> Set of Chromium keys
	ipcMain.handle("browser:insertCss", async (_e, css) => {
		if (noPage() || typeof css !== "string" || css.length > 20000) return null;
		const id = ctx.browserTab?.()?.id;
		const key = await pageWc().insertCSS(css).catch(() => null);
		if (!key || !id) return null;
		if (!tweakCss.has(id)) tweakCss.set(id, new Set());
		tweakCss.get(id).add(key);
		return `${id}|${key}`;
	});
	const ownerOf = (token) => {
		const i = String(token).indexOf("|");
		return i < 0 ? null : { id: String(token).slice(0, i), key: String(token).slice(i + 1) };
	};
	ipcMain.handle("browser:removeCss", async (_e, token) => {
		const o = ownerOf(token);
		if (!o || !tweakCss.get(o.id)?.delete(o.key)) return; // not CSS Tweak put there, or already gone
		const wc = ctx.browserViewOf?.(o.id)?.webContents;
		if (wc && !wc.isDestroyed()) await wc.removeInsertedCSS(o.key).catch(() => {});
	});
	ctx.onTabLeave?.(async ({ id, wc }) => {
		if (ctx.selftest && process.env.PI_CRUST_SELFTEST_VIEWER_BREAK === "tweak-leave") return; // selftest only: the deliberate break
		const keys = [...(tweakCss.get(id) || [])];
		tweakCss.delete(id);
		if (wc && !wc.isDestroyed()) {
			for (const k of keys) await wc.removeInsertedCSS(k).catch(() => {});
			if (keys.length) await wc.executeJavaScript("document.querySelectorAll('[data-pi-tweak]').forEach((n) => n.removeAttribute('data-pi-tweak'))", true).catch(() => {});
		}
		ctx.send("browser:tabLeft", { id });
	});

	// --- Figma variables and the optional tokens file ----------------------------------------------
	ipcMain.handle("design:figmaVariables", async () => {
		try {
			const { callTool } = require("./figma-mcp");
			const { parseDefs } = require("./figma-selection");
			return { defs: parseDefs(await callTool("get_variable_defs", {})) };
		} catch (e) {
			return { error: figmaError(e) };
		}
	});
	ipcMain.handle("design:tokensFile", async () => {
		const rel = ctx.readSettings().designTokensFile;
		if (!rel) return { none: true };
		try {
			let abs;
			try {
				abs = ctx.insideRepo(String(rel)); // also refuses symlinks that leave the repo
			} catch {
				return { error: "designTokensFile must be inside the repo" };
			}
			const st = await fs.promises.stat(abs);
			if (!st.isFile() || st.size > 2 * 1024 * 1024) return { error: `${rel} is not a file or is larger than 2 MB` };
			return { file: rel, tokens: flattenTokensFile(JSON.parse(await fs.promises.readFile(abs, "utf8"))) };
		} catch (e) {
			return { error: `Couldn't read ${rel}: ${(e && e.message) || e}` };
		}
	});
}

module.exports = { register, parseFrameSize, figmaError, flattenTokensFile };
