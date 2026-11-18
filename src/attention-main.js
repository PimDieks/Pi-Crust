// The main process's attention calls: taskbar overlay or dock badge, taskbar flash or dock bounce, and bringing the window forward.
// In a selftest run none of them does anything (a hidden test window must never put anything on a person's screen). One place, with injected
// dependencies, so scripts/native-notify.test.js can call each function with fakes and count what was created.
"use strict";

// deps: { selftest: boolean, getWin: () => BrowserWindow|null, app, isDarwin, isWin, badgeIcon: (n) => NativeImage, createWindow: () => any }
function createAttention(deps) {
	const { selftest, getWin, app, isDarwin, isWin, badgeIcon, createWindow } = deps;
	return {
		badge(n) {
			if (selftest) return; // selftest: no taskbar overlay or badge
			const win = getWin();
			const count = Math.max(0, Math.floor(Number(n)) || 0);
			if (isDarwin) app.dock?.setBadge(count ? String(count) : "");
			else if (isWin) win?.setOverlayIcon(count ? badgeIcon(count) : null, count ? `${count} unread` : "");
			else app.setBadgeCount?.(count);
		},
		bounce() {
			if (selftest) return; // selftest: no taskbar flash or dock bounce
			const win = getWin();
			if (isDarwin && !(win && win.isFocused())) app.dock?.bounce("informational");
			if (isWin && win && !win.isFocused()) win.flashFrame(true); // stops by itself once the window comes to the front
		},
		showWindow() {
			const win = getWin();
			if (!win) return createWindow();
			if (selftest) return; // selftest: never bring a window to the front
			if (win.isMinimized()) win.restore();
			win.show();
			win.focus();
		},
	};
}

module.exports = { createAttention };
