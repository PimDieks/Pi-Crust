// The one place that creates a native (OS) notification. In a selftest run it does nothing, whatever a test step does to `info.selftest`
// (the step `claude-approval` turns that off on purpose): the flag here comes from the main process through the preload and is fixed.
// The main process guards the other attention calls the same way (taskbar flash, dock bounce, badge overlay, bringing the window forward).
// scripts/native-notify.test.js fails when a `new Notification` appears anywhere else in src/.
"use strict";

(function (root) {
	// deps: { selftest: boolean | () => boolean, Notification: constructor | () => constructor }
	function create(deps) {
		return {
			notify(title, options) {
				const quiet = typeof deps.selftest === "function" ? deps.selftest() : deps.selftest;
				if (quiet) return null;
				try {
					const Ctor = typeof deps.Notification === "function" && !deps.Notification.prototype ? deps.Notification() : deps.Notification;
					return new Ctor(title, options);
				} catch {
					return null;
				}
			},
		};
	}
	if (typeof module !== "undefined" && module.exports) module.exports = { create };
	else root.crustNative = create({ selftest: () => !!root.crust?.app?.selftestRun, Notification: () => root.Notification });
})(typeof window !== "undefined" ? window : globalThis);
