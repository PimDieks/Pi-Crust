// Self-test step `viewer-files`: the pi-project:// address (src/project-protocol.js). The checks run in the main process on hidden test windows
// on the project session (viewer-files-selftest-main.js); this step only reports them. Run: npm run selftest -- viewer-files
// Negative controls: PI_CRUST_SELFTEST_VIEWER_BREAK=guard (the request guard lets everything through) or =host (no host check): the step must report MISMATCH.
"use strict";

selftestSteps.push(async () => {
	const r = await crust.selftest.viewerFiles();
	for (const c of r.checks) console.error(`SELFTEST viewer-files ${c.name}: ${c.ok ? "OK" : "MISMATCH"}${c.detail ? " (" + c.detail + ")" : ""}`);
	const bad = r.checks.filter((c) => !c.ok).length + (r.fatal ? 1 : 0);
	console.error(`SELFTEST viewer-files: ${r.checks.length} checks, ${bad ? bad + " MISMATCH" : "all OK"}${r.fatal ? " FATAL " + r.fatal : ""}`);
}, "viewer-files");
