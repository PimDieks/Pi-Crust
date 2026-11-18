// Small PATH helpers shared by the core (finding programs, the terminal shell) and the agent adapters.
"use strict";

const fs = require("node:fs");
const path = require("node:path");

// The PATH key as the environment spells it ("Path" on Windows); setting another spelling would leave two.
const pathKey = (env) => Object.keys(env).find((k) => k.toUpperCase() === "PATH") || "PATH";
// Windows: nvm-windows keeps each version in %NVM_HOME%\vX.Y.Z (node.exe right in it).
const nvmWinHome = () => process.env.NVM_HOME || (process.env.APPDATA ? path.join(process.env.APPDATA, "nvm") : null);
function onPath(name, env = process.env) {
	for (const dir of String(env[pathKey(env)] || "").split(path.delimiter)) {
		if (!dir) continue;
		const p = path.join(dir.replace(/^"|"$/g, ""), name);
		if (fs.existsSync(p)) return p;
	}
	return null;
}

module.exports = { pathKey, nvmWinHome, onPath };
