"use strict";
// The pure list logic of the Viewer's tabs (spec: Viewer tabs and project files, section B). No Electron here, so a node test covers it
// (scripts/viewer-tabs.test.js). The tabs' views and state live in viewer-tabs-main.js; this file only decides order, limit and reuse.
const MAX_TABS = 8;
const PROJECT_SCHEME = "pi-project:";

// "web" (persist:devbrowser) or "project:<host label>" (persist:viewer-project-<host label>, one session per project): by the address,
// never by what a tab used to show.
function sessionOf(address) {
	try {
		const u = new URL(String(address));
		return u.protocol === PROJECT_SCHEME ? "project:" + u.host.toLowerCase() : "web";
	} catch {
		return "web";
	}
}
const isProjectSession = (session) => typeof session === "string" && session.startsWith("project:");
// The site of an address: its host with the port (the project label for a project address). "" when it is not an address.
function siteOf(address) {
	try {
		return new URL(String(address)).host.toLowerCase();
	} catch {
		return "";
	}
}

function create() {
	return { tabs: [], activeId: null, seq: 0 };
}
const find = (list, id) => list.tabs.find((t) => t.id === id) || null;
const active = (list) => find(list, list.activeId);

// A new tab goes right of the active one (at the end when none is active). It becomes the active tab unless `activate` is false.
function add(list, props = {}, { activate = true } = {}) {
	if (list.tabs.length >= MAX_TABS) return { ok: false, reason: "limit" };
	const tab = { ...props, id: `t${++list.seq}` };
	const at = list.tabs.findIndex((t) => t.id === list.activeId);
	list.tabs.splice(at < 0 ? list.tabs.length : at + 1, 0, tab);
	if (activate || !list.activeId) list.activeId = tab.id;
	return { ok: true, tab };
}

function activate(list, id) {
	if (!find(list, id)) return false;
	list.activeId = id;
	return true;
}

// Closing the active tab activates its right neighbour, else its left one. Closing the last tab leaves the list empty: the caller adds
// the replacement on the dev address (`empty` is true then).
function close(list, id) {
	const i = list.tabs.findIndex((t) => t.id === id);
	if (i < 0) return { ok: false, reason: "unknown" };
	const [closed] = list.tabs.splice(i, 1);
	const wasActive = list.activeId === id;
	if (wasActive) list.activeId = (list.tabs[i] || list.tabs[i - 1] || {}).id || null;
	return { ok: true, closed, wasActive, activeId: list.activeId, empty: list.tabs.length === 0 };
}

// A tab to reuse for an address: same session and same site. The active tab wins, then the first in order.
function reusable(list, address) {
	const session = sessionOf(address);
	const site = siteOf(address);
	if (!site) return null;
	const same = (t) => t.session === session && siteOf(t.address) === site;
	const a = active(list);
	return (a && same(a) && a) || list.tabs.find(same) || null;
}

// The tab that already shows this SITE: same scheme, host and port (task 14: stories, Mendix and chat links). Only a web tab counts. The
// active tab wins, then the first in order. null when none.
function originOf(address) {
	try {
		const u = new URL(String(address));
		return u.protocol === "http:" || u.protocol === "https:" ? u.origin.toLowerCase() : "";
	} catch {
		return "";
	}
}
function sameSite(list, address) {
	const origin = originOf(address);
	if (!origin) return null;
	const same = (t) => t.session === "web" && originOf(t.address) === origin;
	const a = active(list);
	return (a && same(a) && a) || list.tabs.find(same) || null;
}

module.exports = { MAX_TABS, sessionOf, isProjectSession, siteOf, originOf, create, find, active, add, activate, close, reusable, sameSite };
