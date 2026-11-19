// Screenshot capture and storage, for before/after shots (turn-shots.js), the timeline and later the Design tab.
//  - captureLive: the dev browser view, also while it is hidden (it keeps its real bounds, see applyBrowserBounds in main.js);
//  - captureUrl: any http(s) page in an offscreen window that shares the dev browser's session, with an emulated
//    viewport / colour scheme;
//  - shots live in userData/shots/<sha1(repo)>/<id>.png (+ a small jpeg thumb) with an index.json of tags; newest 500 kept.
// register(ctx) wires the IPC handlers.
"use strict";

const { BrowserWindow, nativeImage } = require("electron");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const PixelDiff = require("./pixel-diff");
const VK = require("./viewer-kind");

const KEEP = 500;
const BUDGET_BYTES = 400 * 1024 * 1024; // total size of the stored shots per repo
const DESIGN_KEEP = 40; // design captures: few, they are throwaway
const DESIGN_BUDGET_BYTES = 80 * 1024 * 1024;
const THUMB_W = 480;
const MAX_CONCURRENT = 2;
const sha1 = (s) => crypto.createHash("sha1").update(s).digest("hex");

// A small bitmap of an image, for the blank and "nothing changed" checks (cheap, and JPEG thumbs compare fine).
const SMALL_W = 160;
function small(img, width = SMALL_W) {
	const s = img.getSize().width > width ? img.resize({ width, quality: "good" }) : img;
	const { width: w, height: h } = s.getSize();
	return { data: s.toBitmap(), width: w, height: h };
}
// Nearly one colour: an empty page, one still loading, or a blank background. Not worth a screenshot.
const BLANK_SHARE = 0.998; // a page with even a little text or a logo stays above this
const isBlank = (img) => PixelDiff.dominantShare(small(img)) >= BLANK_SHARE;
// The same picture as an earlier shot (the turn changed nothing visible).
function isSame(img, other) {
	if (!other || other.isEmpty()) return false;
	const a = small(img);
	const b = small(other.resize({ width: a.width, height: a.height, quality: "good" }), a.width);
	if (a.width !== b.width || a.height !== b.height) return false;
	const r = PixelDiff.diff(a, b, { threshold: 0.1 });
	return r.diffCount / r.total < 0.001;
}

function register(ctx) {
	const { ipcMain } = ctx;
	// Two buckets: turn shots / timeline (the default) and "design" captures (viewports, stories, annotate, compare), which are
	// ephemeral and have a small cap of their own so they can never evict the shots that belong to a turn.
	const BUCKETS = {
		turn: { sub: "", keep: KEEP, budget: BUDGET_BYTES },
		design: { sub: "design", keep: DESIGN_KEEP, budget: DESIGN_BUDGET_BYTES },
	};
	const kindOf = (v) => (v === "design" ? "design" : "turn");
	const dir = (kind = "turn") => {
		if (!ctx.repo) return null;
		const d = path.join(ctx.app.getPath("userData"), "shots", sha1(ctx.repo), BUCKETS[kind].sub);
		fs.mkdirSync(d, { recursive: true });
		return d;
	};
	const indexFile = (kind) => path.join(dir(kind), "index.json");
	const readIndex = (kind = "turn") => {
		if (!dir(kind)) return [];
		try {
			const l = JSON.parse(fs.readFileSync(indexFile(kind), "utf8"));
			return Array.isArray(l) ? l : [];
		} catch {
			return [];
		}
	};
	const writeIndex = (list, kind = "turn") => {
		const tmp = `${indexFile(kind)}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(list));
		fs.renameSync(tmp, indexFile(kind));
	};
	const rmFiles = (d, id) => {
		for (const ext of ["png", "jpg"]) fs.rmSync(path.join(d, `${id}.${ext}`), { force: true });
	};
	// The bucket an id lives in (the shot's file is the truth), or null.
	const kindOfId = (id) => ["turn", "design"].find((k) => dir(k) && readIndex(k).some((x) => x.id === id)) || null;

	// Saves a nativeImage; returns the index entry.
	function store(img, extra = {}, kind = "turn") {
		const size = img.getSize();
		const id = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
		const d = dir(kind);
		if (!d) throw new Error("No repository");
		const png = img.toPNG();
		const thumb = size.width > THUMB_W ? img.resize({ width: THUMB_W, quality: "good" }) : img;
		const jpg = thumb.toJPEG(72);
		fs.writeFileSync(path.join(d, `${id}.png`), png);
		fs.writeFileSync(path.join(d, `${id}.jpg`), jpg);
		const entry = { id, at: Date.now(), w: size.width, h: size.height, bytes: png.length + jpg.length, tags: {}, ...extra };
		if (kind === "design") entry.kind = "design";
		let list = readIndex(kind);
		list.push(entry);
		// Oldest go first, by count and by total size (the newest shot always stays).
		const { keep, budget } = BUCKETS[kind];
		let total = list.reduce((n, e) => n + (e.bytes || 0), 0);
		let drop = 0;
		while (drop < list.length - 1 && (list.length - drop > keep || total > budget)) total -= list[drop++].bytes || 0;
		for (const old of list.slice(0, drop)) rmFiles(d, old.id);
		list = list.slice(drop);
		writeIndex(list, kind);
		return entry;
	}

	// A never-drawn hidden native view is drawn once, off to the window's corner, by src/offscreen-draw.js (one at a time; it leaves the
	// bounds and visibility to the layout code, ctx.relayout).
	const offscreen = require("./offscreen-draw").create({ relayout: () => ctx.relayout?.() });
	const captureViaOffscreenDraw = (view, wc, rect) => offscreen.draw(view, wc, rect, () => nativeImage.createEmpty());

	// --- live capture of the dev browser -------------------------------------------------------
	// skipEmpty (turn shots): nothing is stored for a page that failed to load or is blank. unlessSameAs: the id of an
	// earlier shot; when the page looks the same nothing is stored ({ ok: false, same: true }). Explicit captures (design)
	// pass neither and always get what is there.
	// The ACTIVE tab (its view has the tab's own session). By its kind (src/viewer-kind.js): a web page or a project page works; an image
	// works for explicit captures (Annotate, Capture build) but never for a turn's before/after shot (pageOnly: no card for that tab); a
	// PDF never.
	async function captureLive({ rect, settleMs = 0, waitLoadMs = 0, kind, skipEmpty = false, unlessSameAs, pageOnly = false, onlyTab } = {}) {
		const view = ctx.browserView;
		if (!ctx.repo) return { ok: false, error: "No repository open" };
		if (!view) return { ok: false, error: "No browser view" };
		const wc = view.webContents;
		const url = wc.getURL();
		const tabKind = ctx.browserTab?.()?.kind || "page";
		const feature = pageOnly ? "shots" : "capture";
		const broken = ctx.browserTab?.()?.broken || ""; // a tab that did not load (or whose file is gone) still holds its old page: nothing to capture
		if (!VK.can(tabKind, feature, broken) && !(ctx.selftest && process.env.PI_CRUST_SELFTEST_VIEWER_BREAK === "kind-capture")) return { ok: false, error: VK.reason(tabKind, feature, broken) };
		const tabId = ctx.browserTab?.()?.id;
		if (onlyTab && onlyTab !== tabId) return { ok: false, error: "The Viewer switched to another tab" }; // an after shot is of the tab the before shot was of
		if (!(/^https?:/i.test(url) || (/^pi-project:/i.test(url) && ctx.isProjectAddress(url))) && !(ctx.selftest && /^data:text\/html/i.test(url))) return { ok: false, error: "The browser has no page open" };
		if (skipEmpty && ctx.browserFailed?.()) return { ok: false, error: "The page did not load" };
		if (settleMs) await new Promise((r) => setTimeout(r, settleMs));
		if (waitLoadMs && wc.isLoading()) {
			await new Promise((resolve) => {
				const done = () => {
					clearTimeout(t);
					wc.removeListener("did-stop-loading", done);
					setTimeout(resolve, 250); // let the new frame paint
				};
				const t = setTimeout(done, waitLoadMs);
				wc.once("did-stop-loading", done);
			});
		}
		const b = view.getBounds();
		if (b.width < 8 || b.height < 8) return { ok: false, error: "The browser view has no size yet" };
		if (skipEmpty && ctx.browserFailed?.()) return { ok: false, error: "The page did not load" }; // failed while we waited
		// Right after a tab was shown or hidden the first capture can fail ("display surface not available", a viz error), most often on a
		// project page or an image: try again, and then without stayHidden (the native view stays hidden either way).
		await offscreen.idle(); // another capture is drawing the view right now: wait, then capture normally
		let img;
		for (let attempt = 0; ; attempt++) {
			try {
				img = await wc.capturePage(rect && rect.width > 0 ? rect : undefined, attempt === 0 ? { stayHidden: true } : undefined);
				break;
			} catch (e) {
				if (attempt >= 3) throw e;
				await new Promise((r) => setTimeout(r, 300));
			}
		}
		// A native view Chromium has never drawn (its tab was never shown) gives an empty image even with stayHidden: draw it once, moved
		// out of the window (1 px left of it, see captureViaOffscreenDraw), then put it back hidden.
		if (img.isEmpty() && !view.getVisible()) img = await captureViaOffscreenDraw(view, wc, rect);
		if (img.isEmpty()) return { ok: false, error: view.getVisible() ? "Empty capture" : "The page has not been drawn yet: open the Viewer tab once" };
		if (skipEmpty && isBlank(img)) return { ok: false, blank: true, error: "The page is blank" };
		if (unlessSameAs) {
			const id = safeId(unlessSameAs);
			const k = id ? kindOfId(id) : null;
			const prev = k ? nativeImage.createFromPath(path.join(dir(k), `${id}.png`)) : null;
			if (prev && isSame(img, prev)) return { ok: false, same: true, error: "Nothing changed on the page" };
		}
		return { ok: true, tabId, entry: store(img, { url, title: wc.getTitle(), blank: false }, kindOf(kind)) };
	}

	// --- capture of an arbitrary URL in an offscreen window ------------------------------------
	let running = 0;
	const waiting = [];
	const slot = () =>
		new Promise((resolve) => {
			const go = () => {
				running++;
				resolve(() => {
					running--;
					waiting.shift()?.();
				});
			};
			if (running < MAX_CONCURRENT) go();
			else waiting.push(go);
		});

	async function captureUrl(url, { width = 1280, height = 800, colorScheme, mobile = false, fullPage = false, settleMs = 800, kind } = {}) {
		url = String(url || "");
		// The window gets the session the address belongs to: a web address the web session, an address of the open project that
		// project's own session (the one a project tab of it has). A PDF is not captured.
		const target = ctx.captureTarget ? ctx.captureTarget(url) : null;
		const isData = ctx.selftest && /^data:text\/html/i.test(url);
		if (!target && !isData) return { ok: false, error: "Only web pages and files of this project can be captured" };
		if (target && !VK.can(target.kind, "capture") && !(ctx.selftest && process.env.PI_CRUST_SELFTEST_VIEWER_BREAK === "kind-capture")) return { ok: false, error: VK.reason(target.kind, "capture") };
		if (!ctx.repo) return { ok: false, error: "No repository open" };
		let prefs = target ? target.webPreferences : { partition: "persist:devbrowser", sandbox: true, contextIsolation: true };
		if (ctx.selftest && process.env.PI_CRUST_SELFTEST_VIEWER_BREAK === "capture-session") prefs = { partition: "persist:devbrowser", sandbox: true, contextIsolation: true }; // selftest only: the deliberate break
		width = Math.max(100, Math.min(3000, Math.round(width)));
		height = Math.max(100, Math.min(4000, Math.round(height)));
		const release = await slot();
		let w;
		let onDownload;
		let ses;
		try {
			w = new BrowserWindow({
				show: false,
				width,
				height,
				// Windows and Linux (e.g. in Docker) paint no frames for a never-shown window (captureScreenshot hangs);
				// offscreen rendering always paints.
				webPreferences: { ...prefs, backgroundThrottling: false, ...(process.platform !== "darwin" ? { offscreen: true } : {}) },
			});
			const wc = w.webContents;
			// This window loads arbitrary pages with the Viewer tab's session: no popups, sound, downloads or odd schemes.
			wc.setWindowOpenHandler(() => ({ action: "deny" }));
			wc.setAudioMuted(true);
			onDownload = (e, _item, from) => {
				if (from === wc) e.preventDefault(); // the session is shared with the dev browser: only block ours
			};
			ses = wc.session;
			ses.on("will-download", onDownload);
			wc.on("will-navigate", (e, to) => {
				if (!(/^(https?|about):/i.test(to) || (/^pi-project:/i.test(to) && ctx.isProjectAddress(to))) && !(ctx.selftest && /^data:text\/html/i.test(to))) e.preventDefault();
			});
			await wc.loadURL("about:blank"); // CDP emulation commands hang on a window that never loaded anything
			wc.debugger.attach("1.3");
			const cdp = (m, p) =>
				Promise.race([wc.debugger.sendCommand(m, p), new Promise((_, rej) => setTimeout(() => rej(new Error(`${m} timed out`)), 20000))]);
			await cdp("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: !!mobile });
			if (colorScheme === "light" || colorScheme === "dark") await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: colorScheme }] });
			await new Promise((resolve, reject) => {
				const t = setTimeout(() => reject(new Error("The page took too long to load")), 20000);
				wc.once("did-finish-load", () => {
					clearTimeout(t);
					resolve();
				});
				wc.on("did-fail-load", (_e, code, desc, _url, isMainFrame) => {
					if (!isMainFrame || code === -3) return; // subframe failures and aborted (redirected) loads aren't the page failing
					clearTimeout(t);
					reject(new Error(desc || `load failed (${code})`));
				});
				wc.loadURL(url).catch(() => {});
			});
			await new Promise((r) => setTimeout(r, settleMs));
			const params = { format: "png", fromSurface: true };
			if (fullPage) {
				const m = await cdp("Page.getLayoutMetrics");
				const cs = m.cssContentSize || m.contentSize;
				params.captureBeyondViewport = true;
				params.clip = { x: 0, y: 0, width: Math.min(cs.width, 3000), height: Math.min(cs.height, 12000), scale: 1 };
			}
			const shot = await cdp("Page.captureScreenshot", params);
			const img = nativeImage.createFromBuffer(Buffer.from(shot.data, "base64"));
			if (img.isEmpty()) return { ok: false, error: "Empty capture" };
			return { ok: true, entry: store(img, { url, title: "" }, kindOf(kind)) };
		} catch (e) {
			return { ok: false, error: String((e && e.message) || e) };
		} finally {
			if (ses && onDownload) ses.removeListener("will-download", onDownload);
			try {
				w?.destroy();
			} catch {}
			release();
		}
	}

	// --- IPC -----------------------------------------------------------------------------------
	function safeId(id) {
		return /^[\w-]+$/.test(String(id)) ? String(id) : null;
	}
	ipcMain.handle("snap:live", (_e, o) => captureLive(o || {}).catch((e) => ({ ok: false, error: String((e && e.message) || e) })));
	ipcMain.handle("snap:url", (_e, url, o) => captureUrl(url, o || {}));
	// Do two stored design captures look the same (the check "nearly": under 0.1% of a 160 px wide copy differs)? Viewports: light and dark of one size.
	ipcMain.handle("snap:same", (_e, idA, idB) => {
		const a = safeId(idA);
		const b = safeId(idB);
		if (!a || !b || !ctx.repo || kindOfId(a) !== "design" || kindOfId(b) !== "design") return false;
		try {
			const d = dir("design");
			return isSame(nativeImage.createFromPath(path.join(d, `${a}.png`)), nativeImage.createFromPath(path.join(d, `${b}.png`)));
		} catch {
			return false;
		}
	});
	ipcMain.handle("snap:get", (_e, id, thumb) => {
		id = safeId(id);
		const kind = id && ctx.repo ? kindOfId(id) : null;
		if (!kind) return null;
		try {
			const buf = fs.readFileSync(path.join(dir(kind), `${id}.${thumb ? "jpg" : "png"}`));
			return `data:image/${thumb ? "jpeg" : "png"};base64,${buf.toString("base64")}`;
		} catch {
			return null;
		}
	});
	// Turn / timeline shots only; design captures are throwaway.
	// Shots whose files are gone or that show a blank page (stored before blank pages were skipped) are left out, so the
	// timeline never shows an empty thumbnail. The blank check runs once per shot and is remembered in the index.
	ipcMain.handle("snap:list", (_e, filter) => {
		const f = filter && typeof filter === "object" ? filter : {};
		const list = readIndex();
		const d = dir();
		let changed = false;
		const out = list.filter((s) => {
			if (!Object.entries(f).every(([k, v]) => s.tags?.[k] === v)) return false;
			if (!d || !fs.existsSync(path.join(d, `${s.id}.jpg`))) return false;
			if (s.blank === undefined) {
				try {
					const img = nativeImage.createFromPath(path.join(d, `${s.id}.jpg`));
					s.blank = img.isEmpty() || isBlank(img);
					changed = true;
				} catch {
					return true;
				}
			}
			return !s.blank;
		});
		if (changed) writeIndex(list);
		return out;
	});
	// For shots that turned out not to be needed (a turn without edits).
	ipcMain.handle("snap:delete", (_e, id) => {
		id = safeId(id);
		const kind = id && ctx.repo ? kindOfId(id) : null;
		if (!kind) return false;
		writeIndex(readIndex(kind).filter((x) => x.id !== id), kind);
		rmFiles(dir(kind), id);
		return true;
	});
	ipcMain.handle("snap:tag", (_e, id, tags) => {
		const kind = ctx.repo ? kindOfId(id) : null;
		if (!kind || !tags || typeof tags !== "object") return null;
		const list = readIndex(kind);
		const s = list.find((x) => x.id === id);
		s.tags = { ...s.tags, ...tags };
		writeIndex(list, kind);
		return s;
	});
	if (ctx.selftest) {
		// Loads a page into the dev browser view so the hidden-view capture can be checked without a dev server.
		ipcMain.handle("snap:selftestLoad", async (_e, html) => {
			const wc = ctx.browserView.webContents;
			await wc.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
			return { url: wc.getURL() };
		});
	}
}

module.exports = { register };
