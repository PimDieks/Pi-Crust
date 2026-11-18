// The one place that says which npm package is Pi and which version this release is tested with.
// Checked with `npm view` on 2026-11-18: @earendil-works/pi-coding-agent is current (latest 1.5.2, publishers mitsuhiko, badlogic, rwachtler);
// the old @mariozechner/pi-coding-agent scope stops at 0.73.1 and is deprecated in favour of it.
// Used by: the install plan and scripts (pinned `name@version`), the "Update Pi" floor (health-logic.js), finding Pi (main.js).
// scripts/install-pi.ps1 and install-pi.sh can't import this: scripts/install-pi.test.js checks that they agree.
"use strict";

const PI_PACKAGE = Object.freeze({ name: "@earendil-works/pi-coding-agent", version: "1.5.2" });

module.exports = { PI_PACKAGE };
