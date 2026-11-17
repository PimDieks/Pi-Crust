// Platform helpers shared by the UI and the picker (loaded first in index.html, also require()-able in tests).
// Repo-relative paths always use "/" (git style); absolute paths are native ("C:\Users\me\repo" on Windows).
(function (root, make) {
	const api = make(typeof module === "object" && module.exports ? process.platform : root.crust?.platform || "darwin");
	if (typeof module === "object" && module.exports) module.exports = api;
	else {
		// One pass over the static markup so tooltips and <kbd> hints read "Ctrl+K" off macOS.
		if (!api.isMac) document.addEventListener("DOMContentLoaded", () => {
			for (const n of document.querySelectorAll("[title],[aria-label]")) for (const a of ["title", "aria-label"]) if (n.hasAttribute(a)) n.setAttribute(a, api.keyLabel(n.getAttribute(a)));
			for (const n of document.querySelectorAll("kbd")) n.textContent = api.keyLabel(n.textContent);
		});
		Object.assign(root, { isMac: api.isMac, isWin: api.isWin, baseName: api.baseName, keyLabel: api.keyLabel, hasMod: api.hasMod, modOnly: api.modOnly, shellQuote: api.shellQuote, shellAnd: api.shellAnd, relUnder: api.relUnder, tildePath: api.tildePath, tildeGuess: api.tildeGuess, fileUri: api.fileUri, absJoin: api.absJoin });
	}
})(typeof window !== "undefined" ? window : globalThis, (platform) => {
	const isMac = platform === "darwin";
	const isWin = platform === "win32";

	// Last segment of an absolute or relative path, either separator.
	const baseName = (p) => String(p || "").split(/[\\/]/).filter(Boolean).pop() || "";

	// Is this absolute path Windows-style? Decided by the path itself, so it also works on any host.
	const winPath = (p) => /^[A-Za-z]:[\\/]|^\\\\/.test(p) || (isWin && !String(p).startsWith("/"));
	const slashed = (p) => String(p).replace(/\\/g, "/");

	// `p` (absolute) relative to the absolute dir `dir`, with "/" separators; null when it is not inside.
	// Windows paths compare case-insensitively and accept either separator.
	function relUnder(p, dir) {
		if (!p || !dir) return null;
		if (winPath(dir)) {
			const a = slashed(p), b = slashed(dir).replace(/\/+$/, "");
			return a.length > b.length && a[b.length] === "/" && a.slice(0, b.length).toLowerCase() === b.toLowerCase() ? a.slice(b.length + 1) : null;
		}
		const base = dir.endsWith("/") ? dir : `${dir}/`;
		return p.startsWith(base) ? p.slice(base.length) : null;
	}

	// "~/x" for paths under the home dir (either separator on Windows); the path unchanged otherwise.
	function tildePath(p, home) {
		if (!p) return p;
		if (home) {
			const rest = relUnder(p, home);
			if (rest !== null) return `~${winPath(home) ? "\\" : "/"}${rest.replace(/\//g, winPath(home) ? "\\" : "/")}`;
			if (p === home) return "~";
		}
		return p;
	}

	// Home-relative display of an absolute path when the home dir is not at hand ("/Users/me/x" or "C:\Users\me\x").
	const tildeGuess = (p) => String(p).replace(/^\/Users\/[^/]+|^[A-Za-z]:\\Users\\[^\\]+/i, "~");

	// A repo-relative path appended to an absolute dir, with the dir's separator.
	const absJoin = (dir, rel) => (winPath(dir) ? `${dir.replace(/[\\/]+$/, "")}\\${String(rel).replace(/\//g, "\\")}` : `${dir}/${rel}`);

	// file: URI path for Monaco ("/C:/Users/me/repo/src/a.js" on Windows).
	function fileUri(dir, rel) {
		const full = slashed(absJoin(dir, rel));
		return winPath(dir) && !full.startsWith("/") ? `/${full}` : full;
	}

	// Glyph shortcut labels ("⌘⇧Space") as Windows text ("Ctrl+Shift+Space"); unchanged on macOS.
	// A modifier run followed by "-" or "/" or a space names the modifier itself ("⌘-click" -> "Ctrl-click").
	const MODS = { "⌘": "Ctrl", "⌃": "Ctrl", "⌥": "Alt", "⇧": "Shift" };
	const ORDER = ["Ctrl", "Alt", "Shift"];
	function keyLabel(text, plat = platform) {
		if (plat === "darwin" || text == null) return text;
		return String(text).replace(/[⌘⌃⌥⇧]+(?=(.?))/g, (run, next) => {
			const names = ORDER.filter((n) => [...run].some((g) => MODS[g] === n));
			return names.join("+") + (next && !/[\s\-/:;)]/.test(next) ? "+" : "");
		});
	}

	// Is the app-shortcut modifier held? Cmd on macOS, Ctrl elsewhere.
	const hasMod = (e) => (isMac ? e.metaKey : e.ctrlKey);
	// ... and only that one (Cmd without Ctrl on macOS, Ctrl without the Windows key elsewhere).
	const modOnly = (e) => (isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey);

	// Quote one argument for the terminal's shell (zsh/bash, or PowerShell on Windows).
	const shellQuote = (s) => (isWin ? `'${String(s).replace(/'/g, "''")}'` : `'${String(s).replace(/'/g, "'\\''")}'`);
	// "a && b" for POSIX shells; PowerShell 5.1 has no &&, so b runs there only when a succeeded.
	const shellAnd = (a, b) => (isWin ? `${a}; if ($?) { ${b} }` : `${a} && ${b}`);

	return { isMac, isWin, baseName, relUnder, tildePath, absJoin, fileUri, tildeGuess, keyLabel, hasMod, modOnly, shellQuote, shellAnd, winPath };
});
