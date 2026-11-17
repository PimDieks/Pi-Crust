// Turns on the repo's git hooks (.githooks: the secret check on commit and push). Run by `npm install` (prepare).
// Does nothing outside a git checkout (e.g. the Docker build or a packaged app).
"use strict";
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
if (fs.existsSync(path.join(root, ".git")) && fs.existsSync(path.join(root, ".githooks"))) {
	try {
		execFileSync("git", ["config", "core.hooksPath", ".githooks"], { cwd: root, stdio: "ignore" });
	} catch {}
}
