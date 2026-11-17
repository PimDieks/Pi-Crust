// Finds the design tokens of a page and checks elements against them (main process; the script runs in the dev browser's page).
// TOKENS_JS defines window.__piTokens = { collect(), check(el) }:
//  - collect(): CSS custom properties from the page's same-origin style sheets (resolved for the current theme) and the MUI theme
//    (palette, spacing, shape, typography) found through the React fibers;
//  - check(el): the element's computed colours, spacing, radius and font matched against those tokens (token-match.js is inlined).
"use strict";

const TokenMatch = require("./token-match");

// MUI theme object -> token lists. Pure, so it can be tested here and inlined into the page.
function muiTokens(theme) {
	const out = { palette: [], spacing: [], radius: [], typography: [] };
	const walk = (prefix, o, depth) => {
		if (!o || typeof o !== "object" || depth > 3) return;
		for (const [k, v] of Object.entries(o)) {
			if (typeof v === "string") {
				if (/^(#|rgb|hsl)/i.test(v) && !/[;{}]/.test(v)) out.palette.push({ name: `palette.${prefix}${k}`, value: v });
			} else walk(`${prefix}${k}.`, v, depth + 1);
		}
	};
	walk("", theme.palette, 0);
	if (typeof theme.spacing === "function") {
		for (let i = 0; i <= 16; i++) {
			const v = theme.spacing(i);
			if (typeof v === "number" || typeof v === "string") out.spacing.push({ name: `spacing(${i})`, value: typeof v === "number" ? `${v}px` : v });
		}
	}
	const br = theme.shape && theme.shape.borderRadius;
	if (br != null) out.radius.push({ name: "shape.borderRadius", value: typeof br === "number" ? `${br}px` : br });
	for (const [k, v] of Object.entries(theme.typography || {})) {
		if (v && typeof v === "object" && v.fontSize != null) {
			const rem = (x) => (/rem$/.test(String(x)) ? `${parseFloat(x) * 16}px` : x);
			out.typography.push({ name: `typography.${k}`, fontSize: rem(v.fontSize), fontWeight: v.fontWeight, lineHeight: typeof v.lineHeight === "number" && v.lineHeight < 10 ? undefined : v.lineHeight, fontFamily: v.fontFamily, letterSpacing: v.letterSpacing });
		}
	}
	return out;
}

const TOKENS_JS = `
(() => {
  if (window.__piTokens && window.__piTokens.v === 1) return true;
  const TM = ${TokenMatch.source}();
  const muiTokens = ${muiTokens.toString()};

  const rootStyle = () => getComputedStyle(document.documentElement);
  const kindOf = (v) => (TM.normalizeColor(v) ? 'color' : /^-?[\\d.]+(px|rem|em)$/.test(v) ? 'length' : 'other');

  // CSS custom properties declared on :root / html (or in inline style), resolved for the current theme.
  function cssVars() {
    const names = new Set();
    const scan = (rules) => {
      for (const r of rules || []) {
        try {
          if (r.cssRules && !r.selectorText) scan(r.cssRules);
          if (!r.style || !r.selectorText || !/(^|,)\\s*(:root|html|body)\\b/.test(r.selectorText)) continue;
          for (let i = 0; i < r.style.length; i++) if (r.style[i].startsWith('--')) names.add(r.style[i]);
        } catch {}
      }
    };
    for (const sheet of document.styleSheets) {
      try { scan(sheet.cssRules); } catch {}
    }
    for (let i = 0; i < document.documentElement.style.length; i++) {
      const n = document.documentElement.style[i];
      if (n.startsWith('--')) names.add(n);
    }
    const cs = rootStyle();
    const out = [];
    for (const name of names) {
      const value = cs.getPropertyValue(name).trim();
      if (value && !/[;{}]/.test(value)) out.push({ name, value, kind: kindOf(value) });
    }
    return out;
  }

  // The MUI theme: the ThemeContext provider's value in the React tree.
  function findMuiTheme() {
    const roots = [document.getElementById('root'), document.getElementById('__next'), document.body].filter(Boolean);
    let start = null;
    for (const r of roots) {
      for (const n of [r, ...r.children]) {
        const k = Object.keys(n).find((k) => k.startsWith('__reactContainer$') || k.startsWith('__reactFiber$'));
        if (k) { start = n[k]; break; }
      }
      if (start) break;
    }
    if (!start) return null;
    const stack = [start];
    let seen = 0;
    while (stack.length && seen++ < 30000) {
      const f = stack.pop();
      const v = f.memoizedProps && f.memoizedProps.value;
      if (v && typeof v === 'object' && v.palette && v.palette.primary && typeof v.spacing === 'function' && v.shape) return v;
      if (f.sibling) stack.push(f.sibling);
      if (f.child) stack.push(f.child);
    }
    return null;
  }

  let cache = null;
  function collect(force) {
    if (cache && !force && Date.now() - cache.at < 3000) return cache.data;
    const vars = cssVars();
    let mui = null;
    try {
      const theme = findMuiTheme();
      if (theme) mui = muiTokens(theme);
    } catch {}
    const bg = getComputedStyle(document.body).backgroundColor;
    const data = { url: location.href, vars, mui, background: TM.normalizeColor(bg) && TM.normalizeColor(bg).a > 0 ? bg : getComputedStyle(document.documentElement).backgroundColor };
    cache = { at: Date.now(), data };
    return data;
  }

  const sets = () => {
    const d = collect();
    const colors = [...d.vars.filter((v) => v.kind === 'color'), ...((d.mui && d.mui.palette) || [])];
    const lengths = [...d.vars.filter((v) => v.kind === 'length'), ...((d.mui && [...d.mui.spacing, ...d.mui.radius]) || [])];
    const radii = [...d.vars.filter((v) => v.kind === 'length' && /radius|round/i.test(v.name)), ...((d.mui && d.mui.radius) || [])];
    const type = (d.mui && d.mui.typography) || [];
    return { colors, lengths, radii, type };
  };

  function check(el) {
    const { colors, lengths, radii, type } = sets();
    if (!colors.length && !lengths.length && !type.length) return { hasTokens: false, items: [] };
    const cs = getComputedStyle(el);
    const items = [];
    const add = (prop, value, m) => items.push({ prop, value, token: m.token, nearest: m.nearest, delta: m.delta });
    for (const prop of ['color', 'background-color', 'border-top-color']) {
      const v = cs.getPropertyValue(prop);
      const c = TM.normalizeColor(v);
      if (!c || c.a === 0) continue;
      if (prop === 'border-top-color' && parseFloat(cs.borderTopWidth) === 0) continue;
      add(prop === 'border-top-color' ? 'border-color' : prop, v, TM.matchColor(v, colors));
    }
    const sides = ['top', 'right', 'bottom', 'left'];
    const pad = sides.map((s) => cs.getPropertyValue('padding-' + s));
    if (lengths.length) {
      const uniq = [...new Set(pad.filter((p) => parseFloat(p) > 0))];
      for (const p of uniq) add('padding', p, TM.matchLength(p, lengths));
      const gap = cs.getPropertyValue('row-gap');
      if (parseFloat(gap) > 0) add('gap', gap, TM.matchLength(gap, lengths));
    }
    const rad = cs.getPropertyValue('border-top-left-radius');
    if (parseFloat(rad) > 0 && (radii.length || lengths.length)) add('border-radius', rad, TM.matchLength(rad, radii.length ? radii : lengths));
    if (type.length) {
      const m = TM.matchTypography({ fontSize: cs.fontSize, fontWeight: cs.fontWeight, lineHeight: cs.lineHeight }, type);
      add('font', cs.fontSize + ' / ' + cs.fontWeight, m);
    }
    return { hasTokens: true, items };
  }

  window.__piTokens = { v: 1, collect, check };
  return true;
})()
`;

module.exports = { TOKENS_JS, muiTokens };
