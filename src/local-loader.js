// Injects machine-local renderer scripts (src/local/*.js, listed by the main process) after the app scripts.
"use strict";

function loadLocalScript(name) {
	return new Promise((resolve) => {
		const s = document.createElement("script");
		s.src = `local/${encodeURIComponent(name)}`;
		s.onload = resolve;
		s.onerror = () => {
			console.error(`[local] ${name} failed to load`);
			resolve();
		};
		document.body.appendChild(s);
	});
}

(async () => {
	try {
		const names = await crust.local.invoke("local:scripts");
		for (const n of names) await loadLocalScript(n);
		if (names.length) console.log(`[local] loaded ${names.join(", ")} (${window.crustLocalCommands.length} commands)`);
	} catch (err) {
		console.error("[local] loader failed:", err);
	}
})();

selftestSteps.push(async () => {
	const cmds = window.crustLocalCommands.map((c) => `/${c.name}`);
	console.error(`SELFTEST local plugins: ${cmds.length} command(s) ${cmds.join(" ")} -> OK`);
});
