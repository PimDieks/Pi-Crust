// What a Viewer tab can do, by the kind of its page: "page" (a web page or a project HTML file), "image" (SVG too) or "pdf". The table is the
// second one in section B of the Viewer tabs spec. Used by the main process (the tools refuse) and by the renderer (the controls are disabled
// with the reason). Back, forward, reload, DevTools and "open in system browser" are not features here: they always work.
"use strict";
(() => {
	// Features: pick (Pick and Tweak both pick), tweak, state (forced states), scheme (light/dark), annotate, capture (Capture build),
	// viewports, shots (the before/after card of a turn).
	const PAGE_ONLY = new Set(["pick", "tweak", "state", "scheme", "shots"]);
	const NEEDS_PAGE_OR_IMAGE = new Set(["annotate", "capture", "viewports"]);
	const norm = (k) => (k === "image" || k === "pdf" ? k : "page");
	const what = (k) => (k === "pdf" ? "a PDF" : "an image");
	// A tab whose page did not load, whose file is gone, or that was remembered and not loaded yet still holds the old page (or none) in its
	// hidden view: the tools that act on the page have nothing to work on. "" | "load" | "missing" | "unloaded", from the tab's error.
	const NEEDS_LOADED_PAGE = new Set(["pick", "tweak", "state", "annotate", "capture", "viewports"]);
	const BROKEN_REASON = {
		load: "Nothing to work on. This page did not load.",
		missing: "Nothing to work on. This file no longer exists.",
		unloaded: "Nothing to work on. This page is not loaded yet. Choose Load.",
	};
	const brokenOf = (error) => (!error ? "" : error.missing ? "missing" : error.unloaded ? "unloaded" : "load");
	function can(kind, feature, broken) {
		if (broken && NEEDS_LOADED_PAGE.has(feature)) return false;
		const k = norm(kind);
		if (k === "page") return true;
		if (PAGE_ONLY.has(feature)) return false;
		if (NEEDS_PAGE_OR_IMAGE.has(feature)) return k === "image";
		return true;
	}
	// "" when the feature works on this kind.
	function reason(kind, feature, broken) {
		if (broken && NEEDS_LOADED_PAGE.has(feature)) return BROKEN_REASON[broken] || BROKEN_REASON.load;
		const k = norm(kind);
		if (can(k, feature)) return "";
		if (NEEDS_PAGE_OR_IMAGE.has(feature)) return `Needs a web page or an image. This tab shows ${what(k)}.`;
		return `Needs a web page. This tab shows ${what(k)}.`;
	}
	// The kind of a project file by its name: "page", "image", "pdf" or "other" (not shown). Mirrors project-files.js kindOf (a test pins it).
	const IMAGE_EXT = new Set(["svg", "png", "jpg", "jpeg", "gif", "webp", "avif", "ico", "bmp"]);
	function fileKind(name) {
		const m = /\.([^./\\]+)$/.exec(String(name || ""));
		const e = m ? m[1].toLowerCase() : "";
		return e === "html" ? "page" : IMAGE_EXT.has(e) ? "image" : e === "pdf" ? "pdf" : "other";
	}
	// A project path the Viewer may be asked to show: a shown kind, and no segment that starts with a dot or is node_modules.
	const viewable = (p) => fileKind(p) !== "other" && !String(p).split(/[\\/]/).some((s) => s.startsWith(".") || s.toLowerCase() === "node_modules");
	const api = { can, reason, brokenOf, norm, fileKind, viewable, PAGE_ONLY, NEEDS_PAGE_OR_IMAGE };
	if (typeof module === "object" && module.exports) module.exports = api;
	else window.ViewerKind = api;
})();
