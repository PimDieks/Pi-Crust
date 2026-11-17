// Element picker for the embedded browser (main process). The PICKER script runs in the page.
const fs = require("node:fs");
const os = require("node:os");
const { TOKENS_JS } = require("./page-tokens");
const path = require("node:path");
const { relUnder } = require("./platform");

const PICKER = String.raw`
new Promise((resolve, reject) => {
  if (window.__piPickCancel) window.__piPickCancel();
  const accent = '#ff3d7f';
  const box = document.createElement('div');
  const label = document.createElement('div');
  const hint = document.createElement('div');
  box.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;border:2px solid ' + accent + ';background:rgba(255,61,127,.12);border-radius:2px;display:none';
  label.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;background:' + accent + ';color:#fff;font:600 11px/1.4 ui-monospace,monospace;padding:1px 6px;border-radius:3px;white-space:nowrap;display:none';
  hint.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;top:8px;left:50%;transform:translateX(-50%);background:#111;color:#fff;font:12px/1.4 system-ui,sans-serif;padding:6px 12px;border-radius:6px;box-shadow:0 2px 8px rgba(0,0,0,.3)';
  hint.textContent = 'pi: click an element · Shift+click to add more · Esc to cancel';
  const marks = [];
  document.documentElement.append(box, label, hint);
  let current = null;
  const picked = [];

  const fiberOf = (el) => {
    for (let n = el; n; n = n.parentElement) {
      const k = Object.keys(n).find((k) => k.startsWith('__reactFiber$'));
      if (k) return n[k];
    }
    return null;
  };
  const nameOf = (t) => {
    if (!t || typeof t === 'string') return null;
    return t.displayName || t.name || (t.render && (t.render.displayName || t.render.name)) || (t.type && nameOf(t.type)) || null;
  };
  const filesFrom = (stack) => {
    if (!stack) return [];
    const s = typeof stack === 'string' ? stack : stack.stack || '';
    const out = [];
    for (const m of s.matchAll(/(https?:\/\/[^\s)]+?):(\d+):(\d+)/g)) {
      let u = m[1];
      if (/node_modules|\/@vite\/|\/@react-refresh|react-dom|jsx-dev-runtime|chunk-/.test(u)) continue;
      try { u = new URL(u).pathname; } catch {}
      u = decodeURIComponent(u.replace(/\?.*$/, '')).replace(/^\/@fs/, '');
      out.push(u);
    }
    return out;
  };
  const reactInfo = (el) => {
    const components = [];
    const sources = [];
    let f = fiberOf(el);
    let depth = 0;
    while (f && depth < 400 && components.length < 12) {
      depth++;
      const n = typeof f.type === 'string' ? null : nameOf(f.type);
      if (n && !/^(Anonymous|Fragment|Provider|Consumer)$/.test(n) && components[components.length - 1] !== n) components.push(n);
      for (const p of filesFrom(f._debugStack)) if (!sources.includes(p)) sources.push(p);
      if (f._debugSource && f._debugSource.fileName) {
        const p = f._debugSource.fileName + ':' + f._debugSource.lineNumber;
        if (!sources.includes(p)) sources.push(p);
      }
      f = f.return;
    }
    return { components, sources: sources.slice(0, 8) };
  };
  const cssPath = (el) => {
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && parts.length < 6; n = n.parentElement) {
      if (n.id && !/^:|\d{3,}/.test(n.id)) { parts.unshift('#' + CSS.escape(n.id)); break; }
      const tid = n.getAttribute('data-testid');
      if (tid) { parts.unshift('[data-testid="' + tid + '"]'); break; }
      let s = n.localName;
      const cls = [...n.classList].filter((c) => !/^css-|^Mui.*-(focused|focusVisible)/.test(c)).slice(0, 2);
      if (cls.length) s += '.' + cls.map((c) => CSS.escape(c)).join('.');
      const p = n.parentElement;
      if (p) {
        const same = [...p.children].filter((c) => c.localName === n.localName);
        if (same.length > 1) s += ':nth-of-type(' + (same.indexOf(n) + 1) + ')';
      }
      parts.unshift(s);
    }
    return parts.join(' > ');
  };
  const STYLE_KEYS = ['display','position','width','height','margin','padding','gap','flex-direction','align-items','justify-content','color','background-color','font-family','font-size','font-weight','line-height','letter-spacing','border','border-radius','box-shadow','opacity','overflow'];
  const colors = window.__piPickColors || {};
  const tokenCheck = (el) => {
    try { return window.__piTokens ? window.__piTokens.check(el) : null; } catch { return null; }
  };
  const SHORT = { 'background-color': 'bg', 'border-color': 'border', 'border-radius': 'radius' };
  const chip = (it) => {
    const c = document.createElement('span');
    const ok = !!it.token;
    const prop = SHORT[it.prop] || it.prop;
    c.textContent = ok ? '\u2713 ' + prop + ' ' + it.token : '\u2717 ' + prop + ' ' + it.value + (it.nearest ? ' (~ ' + it.nearest + ')' : '');
    c.style.cssText = 'padding:0 5px;border-radius:3px;font-weight:500;background:' + (ok ? colors.okBg : colors.warnBg) + ';color:' + (ok ? colors.okText : colors.warnText);
    return c;
  };
  const describe = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const styles = {};
    for (const k of STYLE_KEYS) {
      const v = cs.getPropertyValue(k);
      if (v && !/^(none|normal|auto|0px|visible|static|rgba\(0, 0, 0, 0\))$/.test(v)) styles[k] = v;
    }
    let html = el.outerHTML.replace(/\s+/g, ' ');
    if (html.length > 3000) html = html.slice(0, 3000) + ' …(truncated)';
    const { components, sources } = reactInfo(el);
    return {
      url: location.href,
      selector: cssPath(el),
      tag: el.localName,
      role: el.getAttribute('role'),
      ariaLabel: el.getAttribute('aria-label'),
      testId: el.getAttribute('data-testid'),
      classes: el.className && typeof el.className === 'string' ? el.className : '',
      text: (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 300),
      html,
      rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
      pageRect: { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height },
      styles,
      components,
      sources,
      tokens: tokenCheck(el),
    };
  };
  const ours = (el) => el === box || el === label || el === hint || marks.includes(el);
  const move = (e) => {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || ours(el)) return;
    current = el;
    const r = el.getBoundingClientRect();
    Object.assign(box.style, { display: 'block', left: r.x + 'px', top: r.y + 'px', width: r.width + 'px', height: r.height + 'px' });
    const comp = reactInfo(el).components.find((c) => !/^(Mui|Styled|Emotion|Insertion|ForwardRef)/.test(c));
    label.textContent = '';
    const l1 = document.createElement('div');
    l1.textContent = (comp ? comp + ' · ' : '') + el.localName + ' ' + Math.round(r.width) + '×' + Math.round(r.height);
    label.append(l1);
    const tk = tokenCheck(el);
    const l2 = document.createElement('div');
    l2.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;margin-top:2px;max-width:420px;white-space:normal;font-weight:400';
    if (!tk || !tk.hasTokens) l2.textContent = 'no theme tokens found';
    else for (const it of tk.items.slice(0, 6)) l2.append(chip(it));
    if (l2.childNodes.length) label.append(l2);
    Object.assign(label.style, { display: 'block', left: Math.min(r.x, innerWidth - 440) + 'px', top: '0px' });
    label.style.top = Math.max(0, r.y - label.offsetHeight - 2) + 'px';
  };
  const block = (e) => { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); };
  const cleanup = () => {
    removeEventListener('mousemove', move, true);
    removeEventListener('click', click, true);
    removeEventListener('keydown', key, true);
    for (const t of ['mousedown','mouseup','pointerdown','pointerup']) removeEventListener(t, block, true);
    box.remove(); label.remove(); hint.remove(); marks.forEach((m) => m.remove());
    delete window.__piPickCancel;
  };
  const click = (e) => {
    block(e);
    if (!current) return;
    picked.push(describe(current));
    if (e.shiftKey) {
      const m = box.cloneNode();
      m.style.borderStyle = 'dashed';
      document.documentElement.append(m);
      marks.push(m);
      hint.textContent = 'pi: ' + picked.length + ' selected · Shift+click to add · click to finish · Esc to cancel';
      return;
    }
    cleanup();
    resolve(JSON.stringify(picked));
  };
  const key = (e) => {
    if (e.key !== 'Escape') return;
    block(e);
    cleanup();
    if (picked.length) resolve(JSON.stringify(picked)); else reject(new Error('cancelled'));
  };
  window.__piPickCancel = () => { cleanup(); reject(new Error('cancelled')); };
  addEventListener('mousemove', move, true);
  addEventListener('click', click, true);
  addEventListener('keydown', key, true);
  for (const t of ['mousedown','mouseup','pointerdown','pointerup']) addEventListener(t, block, true);
  setTimeout(() => window.__piPickCancel && window.__piPickCancel(), 5 * 60 * 1000);
})
`;

let picking = false;

// Map a path from the page (vite URL path or absolute) to a repo-relative one.
function toRepoPath(p, repo) {
	const str = String(p);
	const suffix = (str.match(/:\d+(:\d+)?$/) || [""])[0];
	let s = str.slice(0, str.length - suffix.length);
	if (repo) {
		const inside = relUnder(s, repo); // Windows: either separator, drive letter in any case
		if (inside !== null) return inside + suffix;
		const rel = s.replace(/^\//, "");
		const tryList = [rel];
		try {
			for (const d of fs.readdirSync(path.join(repo, "apps"))) tryList.push(path.posix.join("apps", d, rel));
		} catch {}
		try {
			for (const d of fs.readdirSync(path.join(repo, "libs"))) tryList.push(path.posix.join("libs", d, rel));
		} catch {}
		for (const c of tryList) if (fs.existsSync(path.join(repo, c))) return c + suffix;
	}
	return s.replace(/^\//, "") + suffix;
}

const escAttr = (v) => String(v).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// One line: which computed values are theme tokens and which are hard-coded (with the nearest token).
function tokenLine(t) {
	if (!t || !t.hasTokens) return "token check: no theme tokens found on this page";
	if (!t.items.length) return "token check: nothing to check";
	const parts = t.items.map((it) => (it.token ? `${it.prop} ${it.token} ✓` : `${it.prop} ${it.value} ✗ hard-coded${it.nearest ? ` (nearest ${it.nearest}, Δ${it.delta})` : ""}`));
	return `token check: ${parts.join("; ")}`;
}

function format(el, i, total, repo, shot) {
	const lines = [];
	lines.push(`<browser-element${total > 1 ? ` n="${i + 1}"` : ""} url="${escAttr(el.url)}">`);
	lines.push(`selector: ${el.selector}`);
	const attrs = [el.role && `role="${escAttr(el.role)}"`, el.ariaLabel && `aria-label="${escAttr(el.ariaLabel)}"`, el.testId && `data-testid="${escAttr(el.testId)}"`].filter(Boolean);
	lines.push(`element: <${el.tag}>${attrs.length ? " " + attrs.join(" ") : ""}, ${el.rect.width}×${el.rect.height} at (${el.rect.x}, ${el.rect.y})`);
	if (el.classes) lines.push(`classes: ${el.classes}`);
	if (el.components.length) lines.push(`react components (inner → outer): ${el.components.join(" < ")}`);
	if (el.sources.length) lines.push(`source files: ${el.sources.map((s) => toRepoPath(s, repo)).join(", ")}`);
	if (el.text) lines.push(`text: "${el.text}"`);
	const styles = Object.entries(el.styles).map(([k, v]) => `${k}: ${v}`);
	if (styles.length) lines.push(`computed styles: ${styles.join("; ")}`);
	lines.push(tokenLine(el.tokens));
	lines.push("html:", "```html", el.html, "```");
	if (shot) lines.push(`screenshot: ${shot}`);
	lines.push("</browser-element>");
	return lines.join("\n");
}

// Toggle pick mode. Resolves { cancelled } or { text, count }.
// opts.colors: { okBg, okText, warnBg, warnText } for the token chips (the UI passes theme tokens).
async function togglePick(view, repo, opts = {}) {
	const wc = view.webContents;
	if (picking) {
		await wc.executeJavaScript("window.__piPickCancel && window.__piPickCancel()", true).catch(() => {});
		return { cancelled: true, toggled: true };
	}
	picking = true;
	try {
		wc.focus();
		let json;
		try {
			await wc.executeJavaScript(`window.__piPickColors = ${JSON.stringify(opts.colors || {})}; ${TOKENS_JS}`, true).catch(() => {});
			json = await wc.executeJavaScript(PICKER, true);
		} catch (e) {
			if (/cancelled/.test(String(e && e.message))) return { cancelled: true };
			throw e;
		}
		const els = JSON.parse(json);
		const dir = path.join(os.tmpdir(), "pi-crust-pick");
		fs.mkdirSync(dir, { recursive: true });
		const ts = Date.now();
		const bounds = view.getBounds();
		const blocks = [];
		for (const [i, el] of els.entries()) {
			let shot;
			if (el.rect.width >= 1 && el.rect.height >= 1) {
				try {
					const pad = 8;
					const x = Math.max(0, el.rect.x - pad);
					const y = Math.max(0, el.rect.y - pad);
					const w = Math.min(el.rect.x + el.rect.width + pad, bounds.width) - x;
					const h = Math.min(el.rect.y + el.rect.height + pad, bounds.height) - y;
					if (w >= 1 && h >= 1) {
						const img = await wc.capturePage({ x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h) });
						shot = path.join(dir, `${ts}-${i + 1}.png`);
						fs.writeFileSync(shot, img.toPNG());
					}
				} catch {}
			}
			blocks.push(format(el, i, els.length, repo, shot));
		}
		return { text: blocks.join("\n\n") + "\n\n", items: blocks, count: els.length, raw: els };
	} finally {
		picking = false;
	}
}

module.exports = { togglePick, PICKER, tokenLine, format, toRepoPath };
