// Light / dark theme (semantic-colors). Setting: "system" | "light" | "dark", kept in localStorage.
// Loaded first in index.html so the right theme is set before anything paints.
"use strict";

const THEME_KEY = "crust.theme";
const THEME_ORDER = ["system", "light", "dark"];
const THEME_LABELS = { system: "System", light: "Light", dark: "Dark" };
const themeMedia = matchMedia("(prefers-color-scheme: dark)");
const themeListeners = new Set();

function themeSetting() {
	const v = localStorage.getItem(THEME_KEY);
	return THEME_ORDER.includes(v) ? v : "system";
}

// The theme in effect: "light" or "dark".
function currentTheme() {
	const s = themeSetting();
	return s === "system" ? (themeMedia.matches ? "dark" : "light") : s;
}

function applyTheme() {
	const theme = currentTheme();
	document.documentElement.dataset.theme = theme;
	const btn = document.getElementById("theme-toggle");
	if (btn) {
		const s = themeSetting();
		btn.dataset.setting = s;
		const next = THEME_ORDER[(THEME_ORDER.indexOf(s) + 1) % THEME_ORDER.length];
		btn.title = `Theme: ${THEME_LABELS[s]} (click for ${THEME_LABELS[next]})`;
		btn.setAttribute("aria-label", btn.title);
	}
	for (const fn of themeListeners) {
		try {
			fn(theme);
		} catch (e) {
			console.error(e);
		}
	}
}

let themeFadeTimer;
function setTheme(setting) {
	localStorage.setItem(THEME_KEY, THEME_ORDER.includes(setting) ? setting : "system");
	// Cross-fade the colours (styles.css: html.theme-changing) instead of flashing.
	const root = document.documentElement;
	root.classList.add("theme-changing");
	clearTimeout(themeFadeTimer);
	themeFadeTimer = setTimeout(() => root.classList.remove("theme-changing"), 320);
	applyTheme();
}

function cycleTheme() {
	setTheme(THEME_ORDER[(THEME_ORDER.indexOf(themeSetting()) + 1) % THEME_ORDER.length]);
}

function onThemeChange(fn) {
	themeListeners.add(fn);
}

themeMedia.addEventListener("change", () => themeSetting() === "system" && applyTheme());
applyTheme();
document.addEventListener("DOMContentLoaded", () => {
	document.getElementById("theme-toggle")?.addEventListener("click", cycleTheme);
	applyTheme();
});
