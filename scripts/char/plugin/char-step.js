// Characterization harness (renderer side): one selftest step called "char" that waits until the main-side driver is done.
// Run with `npm run selftest -- char`. Copied to src/local/ by scripts/char/run.js for one run.
selftestSteps.push(async () => {
	await crust.local.invoke("local:char-wait");
}, "char");
