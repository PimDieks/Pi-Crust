// Ends a child process and everything it started (subagents, running commands).
// POSIX: the child leads its own process group (spawned with detached: true), so the group gets the signal; throws ESRCH
// like process.kill when nothing is left. Windows: there are no groups, `taskkill /T` walks the tree; `force` adds /F
// (taskkill without /F only asks windowed processes to close). `sync` waits for taskkill (process "exit" handlers).
// Windows limit: the tree is found through the live root, so once the child has exited its orphans can't be reached;
// then nothing is done (taskkill would fail, and the pid may already belong to another process).
"use strict";

const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const TASKKILL = () => path.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe");

function killTree(proc, force = false, { sync = false } = {}) {
	if (!proc || !proc.pid) return;
	if (process.platform !== "win32") return process.kill(-proc.pid, force ? "SIGKILL" : "SIGTERM");
	if (proc.exitCode != null || proc.signalCode != null) return false;
	const args = ["/pid", String(proc.pid), "/T", ...(force ? ["/F"] : [])];
	if (sync) spawnSync(TASKKILL(), args, { windowsHide: true, stdio: "ignore" });
	else spawn(TASKKILL(), args, { windowsHide: true, stdio: "ignore" }).on("error", () => {});
	return true;
}

module.exports = { killTree };
