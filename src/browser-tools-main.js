// Dev browser tools, main side: a colour-scheme override (Auto / Light / Dark) and forced element states
// (:hover, :focus, :focus-visible, :active, disabled) on the last picked element. Both use CDP on the
// browser view's webContents through one shared attachment (cdp below); nothing else attaches there.
"use strict";

const SCHEMES = ["auto", "light", "dark"];
const PSEUDO = ["hover", "focus", "focus-visible", "active"];
const NATIVE_DISABLE = new Set(["button", "input", "select", "textarea", "fieldset", "optgroup", "option"]);

const normalizeScheme = (s) => (SCHEMES.includes(s) ? s : "auto");
// Form controls take the real `disabled` attribute; anything else gets aria-disabled.
const disableAttr = (tag) => (NATIVE_DISABLE.has(String(tag).toLowerCase()) ? ["disabled", ""] : ["aria-disabled", "true"]);
const cleanPseudo = (list) => PSEUDO.filter((p) => Array.isArray(list) && list.includes(p));
const emptyForced = () => ({ pseudo: [], attr: null, cls: null, focused: false, hovered: false });
// The element that gets the state: the picked one, or its nearest interactive ancestor.
const INTERACTIVE = 'button,a[href],input,select,textarea,summary,label,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="option"],[role="checkbox"],[role="radio"],[role="switch"],[role="slider"],[role="combobox"],[tabindex]:not([tabindex="-1"]),[contenteditable="true"]';
const resolveExpr = (selector) => `(() => { const el = document.querySelector(${JSON.stringify(String(selector))}); return el ? el.closest(${JSON.stringify(INTERACTIVE)}) || el : null; })()`;
function describeEl() {
	const cls = typeof this.className === "string" ? this.className.trim().split(/\s+/).filter((c) => c && !/^css-/.test(c)).slice(0, 2) : [];
	return this.tagName.toLowerCase() + (this.id ? `#${this.id}` : "") + cls.map((c) => `.${c}`).join("");
}

function register(ctx) {
	let scheme = normalizeScheme(ctx.readSettings().browserScheme);
	let target = null; // CSS selector of the last picked element
	let forced = emptyForced(); // what is applied right now
	let wired = null;
	const wc = () => ctx.browserView?.webContents;

	// The single place that attaches the debugger to the dev browser.
	async function cdp(method, params) {
		const w = wc();
		if (!w || w.isDestroyed()) throw new Error("No browser");
		if (!w.debugger.isAttached()) w.debugger.attach("1.3");
		if (wired !== w) {
			wired = w;
			w.debugger.on("detach", () => {
				forced = emptyForced(); // DevTools or a crash dropped the session: its overrides are gone
			});
		}
		return await Promise.race([w.debugger.sendCommand(method, params), new Promise((_, rej) => setTimeout(() => rej(new Error(`${method} timed out`)), 5000))]);
	}

	async function applyScheme() {
		const w = wc();
		if (!w || w.isDestroyed()) return;
		if (scheme === "auto" && !w.debugger.isAttached()) return; // nothing was overridden
		try {
			await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme === "auto" ? "" : scheme }] });
		} catch {}
	}

	// Resolves the target to the element to force: the nearest interactive ancestor of the picked element
	// (picking a button's label span should force the button). Node ids don't survive navigations or a new
	// DOM.getDocument, so this runs fresh for every change. Returns { nodeId, objectId, mui } or null.
	async function resolve(selector) {
		await cdp("DOM.enable");
		await cdp("CSS.enable");
		const { result } = await cdp("Runtime.evaluate", { expression: resolveExpr(selector) });
		if (!result?.objectId) return null;
		await cdp("DOM.getDocument", { depth: 0 }); // DOM.requestNode needs the document requested first
		const { nodeId } = await cdp("DOM.requestNode", { objectId: result.objectId });
		return nodeId ? { nodeId, objectId: result.objectId } : null;
	}
	const onEl = async (objectId, fn, ...args) =>
		(await cdp("Runtime.callFunctionOn", { objectId, functionDeclaration: fn.toString(), arguments: args.map((value) => ({ value })), returnByValue: true }))?.result?.value;

	// Moves the (virtual) mouse over the element, so JS hover handlers, tooltips and ancestor :hover rules
	// react too, not just the element's own :hover. Moving the real mouse into the page undoes it.
	async function hoverEl(objectId, on) {
		const w = wc();
		let x = -10, y = -10;
		if (on) {
			const r = await onEl(objectId, function () {
				this.scrollIntoView({ block: "nearest", inline: "nearest" });
				const b = this.getBoundingClientRect();
				return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
			});
			const z = w?.getZoomFactor?.() || 1;
			x = r.x * z;
			y = r.y * z;
		}
		await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
	}

	async function clearForced() {
		const prev = forced;
		forced = emptyForced();
		if (!target || !(prev.pseudo.length || prev.attr || prev.cls || prev.focused || prev.hovered)) return;
		try {
			const el = await resolve(target);
			if (!el) return;
			await undo(el, prev);
		} catch {}
		cdp("Emulation.setFocusEmulationEnabled", { enabled: false }).catch(() => {});
	}
	async function undo(el, prev) {
		if (prev.pseudo.length) await cdp("CSS.forcePseudoState", { nodeId: el.nodeId, forcedPseudoClasses: [] });
		if (prev.attr) await cdp("DOM.removeAttribute", { nodeId: el.nodeId, name: prev.attr });
		if (prev.cls) await onEl(el.objectId, function (c) { this.classList.remove(c); }, prev.cls);
		if (prev.focused) await onEl(el.objectId, function () { this.blur(); });
		if (prev.hovered) await hoverEl(el.objectId, false);
	}

	async function setForced(opts) {
		if (!target) return { error: "Pick an element first" };
		const pseudo = cleanPseudo(opts?.pseudo);
		const wantDisabled = !!opts?.disabled;
		try {
			const el = await resolve(target);
			if (!el) {
				forced = emptyForced();
				return { error: "The picked element is no longer on the page" };
			}
			const { nodeId, objectId } = el;
			const any = pseudo.length || wantDisabled;
			// Keep the page "focused" while the app UI has focus, otherwise clicking a checkbox here blurs the
			// element again (and MUI drops .Mui-focused).
			await cdp("Emulation.setFocusEmulationEnabled", { enabled: !!any });

			// CSS: the element's own pseudo-classes. Set before focusing, so a focus handler that checks
			// el.matches(":focus-visible") (MUI's focus-visible detection) sees it.
			await cdp("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: pseudo });
			forced.pseudo = pseudo;

			// JS: real focus, so focus handlers run (.Mui-focused, .Mui-focusVisible, :focus-within on parents).
			const wantFocus = pseudo.includes("focus") || pseudo.includes("focus-visible");
			if (wantFocus && !forced.focused) {
				if (pseudo.includes("focus-visible")) await cdp("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16 }).then(() => cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16 })); // keyboard modality
				await onEl(objectId, function () { this.blur(); this.focus({ preventScroll: true }); });
				forced.focused = true;
			} else if (!wantFocus && forced.focused) {
				await onEl(objectId, function () { this.blur(); });
				forced.focused = false;
			}

			// Mouse: a real hover.
			const wantHover = pseudo.includes("hover");
			if (wantHover !== forced.hovered) {
				await hoverEl(objectId, wantHover);
				forced.hovered = wantHover;
			}

			// Disabled: the attribute, plus MUI's state class when the element is an MUI component.
			if (wantDisabled && !forced.attr) {
				const { node } = await cdp("DOM.describeNode", { nodeId });
				const [name, value] = disableAttr(node.nodeName);
				await cdp("DOM.setAttributeValue", { nodeId, name, value });
				forced.attr = name;
				const added = await onEl(objectId, function () {
					if (![...this.classList].some((c) => c.startsWith("Mui")) || this.classList.contains("Mui-disabled")) return null;
					this.classList.add("Mui-disabled");
					return "Mui-disabled";
				});
				forced.cls = added || null;
			} else if (!wantDisabled && forced.attr) {
				await cdp("DOM.removeAttribute", { nodeId, name: forced.attr });
				if (forced.cls) await onEl(objectId, function (c) { this.classList.remove(c); }, forced.cls);
				forced.attr = null;
				forced.cls = null;
			}
			return { ok: true, element: await onEl(objectId, describeEl) };
		} catch (e) {
			return { error: String((e && e.message) || e) };
		}
	}

	const setTarget = (sel) => {
		target = sel || null;
		ctx.send("browser:target", { selector: target });
	};

	ctx.ipcMain.handle("browser:scheme", async (_e, value) => {
		if (value !== undefined) {
			scheme = normalizeScheme(value);
			ctx.writeSettings({ browserScheme: scheme });
			await applyScheme();
		}
		return scheme;
	});
	ctx.ipcMain.handle("browser:target", () => ({ selector: target }));
	ctx.ipcMain.handle("browser:forceState", (_e, opts) => setForced(opts));

	// Called from main.js once the browser view exists.
	module.exports.attach = (w) => {
		const reapply = () => void applyScheme();
		w.on("did-navigate", reapply);
		w.on("did-finish-load", reapply);
		w.on("did-start-navigation", (d) => {
			if (!d.isMainFrame || d.isSameDocument) return;
			forced = emptyForced(); // the new document starts clean
			if (target) setTarget(null);
		});
		reapply();
	};
	// Called with each pick result; the last element picked becomes the target for forced states.
	module.exports.notePick = async (r) => {
		const last = r?.raw?.[r.raw.length - 1];
		if (!last?.selector) return;
		await clearForced();
		setTarget(last.selector);
	};
}

module.exports = { register, normalizeScheme, disableAttr, cleanPseudo, resolveExpr, INTERACTIVE, SCHEMES, PSEUDO };
