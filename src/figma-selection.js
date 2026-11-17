// Pure helpers: turn Figma desktop MCP output (get_design_context + get_variable_defs) into a <figma-node> block.
"use strict";

const MAX_ELEMENTS = 6;
const MAX_ENTRIES = 40;

const SIDES = { t: "top", r: "right", b: "bottom", l: "left" };
const CORNERS = { tl: "top-left", tr: "top-right", bl: "bottom-left", br: "bottom-right" };

// Tailwind class → list of CSS-ish property names (value in `[...]`), or null.
function propsFor(prefix, inner) {
	let m;
	if (prefix === "bg") return /^(color:|var\(|#|rgb)/.test(inner) ? ["background"] : null;
	if (prefix === "text") {
		if (/^color:/.test(inner) || /^(#|rgb)/.test(inner)) return ["color"];
		if (/^length:/.test(inner) || /^-?[\d.]+(px|rem|em)?$/.test(inner) || /^var\(--(font-size|text|desktop|mobile)/i.test(inner)) return ["font-size"];
		return /^var\(/.test(inner) ? ["color"] : null;
	}
	if (prefix === "border") {
		if (/^color:/.test(inner) || /^(#|rgb)/.test(inner) || /^var\(/.test(inner)) return ["border-color"];
		return /^-?[\d.]+px$/.test(inner) ? ["border-width"] : null;
	}
	if (prefix === "p") return ["padding"];
	if (prefix === "px") return ["padding-x"];
	if (prefix === "py") return ["padding-y"];
	if ((m = /^p([trbl])$/.exec(prefix))) return [`padding-${SIDES[m[1]]}`];
	if (prefix === "gap") return ["gap"];
	if (prefix === "gap-x" || prefix === "gap-y") return [prefix];
	if (prefix === "rounded") return ["radius"];
	if ((m = /^rounded-(tl|tr|bl|br)$/.exec(prefix))) return [`radius-${CORNERS[m[1]]}`];
	if (prefix === "w") return ["width"];
	if (prefix === "h") return ["height"];
	if (prefix === "size") return ["width", "height"];
	if (prefix === "leading") return ["line-height"];
	return null;
}

const unescapeVar = (s) => s.replace(/\\\//g, "/").replace(/\\(.)/g, "$1");

// Map a CSS-var name (lowercased, dashes) back to the original key from get_variable_defs.
function makeResolver(defs) {
	const norm = (s) => s.toLowerCase().replace(/\s+/g, "-");
	const byNorm = new Map(Object.keys(defs).map((k) => [norm(k), k]));
	return (cssName) => {
		const n = unescapeVar(cssName);
		return byNorm.get(norm(n)) || n;
	};
}

// Value inside brackets → { variable } or { raw }.
function parseValue(inner, resolve) {
	const v = inner.replace(/^(color|length|string|number):/, "");
	const m = /^var\(--([^,)]+)(?:,(.*))?\)$/.exec(v);
	if (m) return { variable: resolve(m[1]) };
	return { raw: v.replace(/_/g, " ") };
}

function parseDefs(text) {
	if (!text) return {};
	const start = text.indexOf("{");
	if (start < 0) return {};
	let depth = 0;
	let inStr = false;
	for (let i = start; i < text.length; i++) {
		const c = text[i];
		if (inStr) {
			if (c === "\\") i++;
			else if (c === '"') inStr = false;
		} else if (c === '"') inStr = true;
		else if (c === "{") depth++;
		else if (c === "}" && --depth === 0) {
			try {
				return JSON.parse(text.slice(start, i + 1));
			} catch {
				return {};
			}
		}
	}
	return {};
}

// → { rootId, rootName, elements: [{ id, label, entries: [{ prop, variable?, raw? }] }] }
function parseDesignContext(text, defs = {}) {
	const resolve = makeResolver(defs);
	const tags = [...text.matchAll(/<[A-Za-z][\w.]*\s[^>]*?\bdata-node-id="([^"]+)"[^>]*>/g)];
	const out = { rootId: tags[0]?.[1] || null, rootName: null, elements: [], sparse: false };
	// Large selections: Figma returns sparse metadata XML (`<frame id="…" name="…">`) instead of JSX.
	if (!tags.length) {
		const m = /<[a-z][\w-]*\s[^>]*?\bid="([^"]+)"[^>]*>/i.exec(text);
		if (m) {
			out.rootId = m[1];
			out.rootName = (/\bname="([^"]*)"/.exec(m[0]) || [])[1] || null;
			out.sparse = true;
		}
		return out;
	}
	const seenSets = new Set();
	let total = 0;
	for (const [i, t] of tags.entries()) {
		const tag = t[0];
		const id = t[1];
		const name = (/\bdata-name="([^"]*)"/.exec(tag) || [])[1] || null;
		if (i === 0) out.rootName = name;
		const cls = (/\bclassName="([^"]*)"/.exec(tag) || [])[1] || "";
		const entries = [];
		const seen = new Set();
		for (const c of cls.split(/\s+/)) {
			const m = /^([a-z][a-z-]*?)-\[(.+)\]$/.exec(c);
			if (!m) continue;
			const props = propsFor(m[1], m[2]);
			if (!props) continue;
			const val = parseValue(m[2], resolve);
			for (const prop of props) {
				const key = `${prop}|${val.variable || ""}|${val.raw || ""}`;
				if (seen.has(key)) continue;
				seen.add(key);
				entries.push({ prop, ...val });
			}
		}
		if (!entries.length) continue;
		const sig = JSON.stringify(entries);
		if (i > 0 && seenSets.has(sig)) continue;
		seenSets.add(sig);
		if (out.elements.length >= MAX_ELEMENTS || total >= MAX_ENTRIES) break;
		const room = MAX_ENTRIES - total;
		const kept = entries.slice(0, room);
		total += kept.length;
		out.elements.push({ id, label: name || id, entries: kept });
	}
	return out;
}

const attr = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

function figmaUrl(fileKey, fileName, nodeId) {
	return `https://www.figma.com/design/${fileKey}/${encodeURIComponent(fileName || "file")}?node-id=${String(nodeId).replace(/:/g, "-")}`;
}

function buildBlock({ context, defsText, fileKey, fileName }) {
	const defs = parseDefs(defsText);
	const sel = parseDesignContext(context, defs);
	if (!sel.rootId) return null;
	const name = sel.rootName || sel.rootId;
	const lines = [`<figma-node url="${attr(figmaUrl(fileKey, fileName, sel.rootId))}" file-key="${attr(fileKey)}" node-id="${attr(sel.rootId)}" name="${attr(name)}">`];
	const vars = Object.entries(defs).map(([k, v]) => `${k} = ${String(v).length > 80 ? String(v).slice(0, 79) + "…" : v}`);
	if (vars.length) lines.push(`variables: ${vars.join("; ")}`);
	if (sel.sparse) lines.push("note: selection too large for per-layer styles; call get_design_context on sublayers for details");
	for (const el of sel.elements) {
		const parts = el.entries.map((e) => (e.variable ? `${e.prop} → ${e.variable}` : `${e.prop} → ${e.raw} (no token)`));
		lines.push(`${el.label}: ${parts.join("; ")}`);
	}
	lines.push("</figma-node>");
	return lines.join("\n");
}

// https://www.figma.com/design/<key>/<name>?… (also /file/, /board/) → { key, name } | null
function parseFigmaUrl(text) {
	const m = /https?:\/\/(?:www\.)?figma\.com\/(?:design|file|board)\/([A-Za-z0-9]+)(?:\/([^?\s#]*))?/.exec(text || "");
	if (!m) return null;
	let name = m[2] || "";
	try {
		name = decodeURIComponent(name);
	} catch {}
	name = name.trim();
	return { key: m[1], name: name || m[1] };
}

module.exports = { parseDefs, parseDesignContext, buildBlock, parseFigmaUrl, figmaUrl };
