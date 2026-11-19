"use strict";
// What the Viewer remembers of its tabs, per project (spec: Viewer tabs and project files, section B "Remembered", section C "Deleted or
// switched", task 7). No Electron here, so a node test covers it (scripts/viewer-tabs.test.js). The tab model (viewer-tabs-main.js) calls
// `toStored` to build what goes into Pi Crust's settings.json and `fromStored` to turn it back into tabs.
//
// Stored under settings.json "viewerTabs", keyed like "figmaFiles" (the project's real path, lower-cased on Windows):
//   { "<project key>": { "tabs": [ { "address": "http://localhost:5173/", "title": "App" }, { "path": "docs/pricing.html", "title": "Pricing" } ],
//                        "active": 1 } }
// Per tab its address (a web page) or its project path (a file of the project) and its title; which tab is active (an index). Nothing
// else: no history, no scroll position, no page content.
//
// A stored entry is data, never trusted: every address goes through the same checks as one typed by hand (http, https, or a file of
// THIS project that project-files accepts and the Viewer shows); anything else is dropped. A file that no longer exists is not dropped:
// it comes back with `missing: true`.
const L = require("./viewer-tabs-list");

const TITLE_MAX = 200;
const ADDRESS_MAX = 2048;
const MAX_ENTRIES = 64; // read at most this many stored entries; the list keeps the first 8 that pass

const cleanTitle = (t) => (typeof t === "string" ? t.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, TITLE_MAX) : "");
const sameAddress = (a, b) => String(a || "").replace(/\/$/, "") === String(b || "").replace(/\/$/, "");

// The tabs of the list as they would be saved. A tab that cannot be saved (an address that is neither http(s) nor a file of this project)
// is left out. `active` is the index among the saved tabs.
function toStored(list, { root, protocol }) {
	const tabs = [];
	let active = -1;
	for (const t of list.tabs) {
		let entry = null;
		if (L.isProjectSession(t.session)) {
			const p = protocol.fromAddress(root, t.address);
			if (p) entry = { path: p, title: cleanTitle(t.title) };
		} else if (/^https?:\/\//i.test(String(t.address || "")) && String(t.address).length <= ADDRESS_MAX) {
			entry = { address: String(t.address), title: cleanTitle(t.title) };
		}
		if (!entry) continue;
		if (t.id === list.activeId) active = tabs.length;
		tabs.push(entry);
	}
	return { tabs, active: Math.max(0, active) };
}

// True when the list is what a first run shows: one tab on the dev address. Nothing is stored for that.
function isDefault(list, devUrl) {
	const only = list.tabs.length === 1 ? list.tabs[0] : null;
	return !!only && only.session === "web" && sameAddress(only.address, devUrl);
}

// One address: { session, address, kind, missing } or null. `missing`: a file of the project that is not there now.
function checkAddress(address, { root, protocol, files }) {
	let u;
	try { u = new URL(String(address)); } catch { return null; }
	if (u.protocol === "http:" || u.protocol === "https:") return { session: "web", address: u.href, kind: "page", missing: false };
	if (u.protocol !== protocol.SCHEME + ":") return null; // file:, javascript:, data:, anything else
	const p = protocol.fromAddress(root, u.href); // another project's address gives null
	if (p == null) return null;
	const kind = files.kindOf(p);
	if (kind === "other") return null;
	const r = files.resolve(root, u.pathname, "GET");
	if (!r.ok && r.status !== 404) return null; // refused by the path rules (a dot, "..", a link out of the project...): dropped
	return { session: L.sessionOf(u.href), address: u.href, kind, missing: !r.ok };
}

// The stored value of one project -> checked tabs and the index of the active one, or null when there is nothing usable.
function fromStored(raw, { root, protocol, files }) {
	if (!root || !raw || typeof raw !== "object" || !Array.isArray(raw.tabs)) return null;
	const tabs = [];
	let active = -1;
	raw.tabs.slice(0, MAX_ENTRIES).forEach((e, i) => {
		if (tabs.length >= L.MAX_TABS || !e || typeof e !== "object") return;
		let address;
		if (typeof e.path === "string") {
			// A project path: checked as the request it would become, before any address is built (a URL parser would quietly resolve "..").
			const segs = e.path.replace(/\\/g, "/").split("/").filter((s) => s !== "");
			const probe = files.resolve(root, "/" + segs.map(encodeURIComponent).join("/"), "GET");
			if (!segs.length || (!probe.ok && probe.status !== 404)) return;
			address = protocol.toAddress(root, e.path);
		} else if (typeof e.address === "string" && e.address.length <= ADDRESS_MAX) {
			address = e.address;
		} else return;
		const c = checkAddress(address, { root, protocol, files });
		if (!c) return;
		if (i === raw.active) active = tabs.length;
		tabs.push({ ...c, title: cleanTitle(e.title) });
	});
	return tabs.length ? { tabs, active: Math.max(0, active) } : null;
}

module.exports = { TITLE_MAX, toStored, isDefault, fromStored, checkAddress };
