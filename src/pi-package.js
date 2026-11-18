// The one place that says which npm package is Pi and which version this release installs.
// Checked with `npm view` on 2026-11-18: @earendil-works/pi-coding-agent@1.4.0 exists (engines node >=22.19.0).
// The old @mariozechner/pi-coding-agent scope stops at 0.73.1 and is deprecated: never installed, but a Pi installed from it is still FOUND.
// Used by: the install plan and scripts (pinned `name@version`), finding Pi (main.js, subscriptions-main.js).
// The "Update Pi" row does NOT use this version: see MIN_PI in health-logic.js.
// scripts/install-pi.ps1 and install-pi.sh can't import this: scripts/install-pi.test.js checks that they agree.
"use strict";

// version: the version this release was tested with; raise it only after the tests pass on the new version.
const PI_PACKAGE = Object.freeze({ name: "@earendil-works/pi-coding-agent", version: "1.4.0" });
const PI_OLD_NAMES = Object.freeze(["@mariozechner/pi-coding-agent"]); // deprecated scope: looked for, never installed

module.exports = { PI_PACKAGE, PI_OLD_NAMES };
