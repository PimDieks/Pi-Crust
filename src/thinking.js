// Thinking-level select in the composer bar (same look as #perm-mode).
"use strict";

(() => {
	const sel = $("#thinking-level");
	let busy = false;

	async function refresh(c = active, data) {
		if (!c || c !== active) return;
		if (!c.state.ready) {
			sel.hidden = true; // Pi is (re)starting: nothing to pick from yet
			sel.replaceChildren();
			return;
		}
		const [lv, st] = await Promise.all([rpcTo(c, "get_available_thinking_levels"), data ? Promise.resolve({ data }) : rpcTo(c, "get_state")]);
		if (c !== active) return;
		const levels = lv.data?.levels || [];
		const current = st.data?.thinkingLevel;
		sel.replaceChildren(
			...levels.map((l) => {
				const o = el("option", "", l);
				o.value = l;
				return o;
			}),
		);
		if (current && levels.includes(current)) sel.value = current;
		sel.dataset.level = sel.value;
		sel.hidden = !levels.length || (levels.length === 1 && levels[0] === "off");
	}
	window.refreshThinking = () => refresh();

	sel.addEventListener("change", async () => {
		if (busy) return;
		busy = true;
		sel.disabled = true;
		const c = active;
		const prev = sel.dataset.level;
		const res = await rpcTo(c, "set_thinking_level", { level: sel.value });
		if (c === active) {
			if (!res.success) sel.value = prev;
			else sel.dataset.level = sel.value;
		}
		if (!res.success) toast(res.error || "Couldn't set thinking level", "error");
		sel.disabled = false;
		busy = false;
	});

	onCrust("models:loaded", (c, data) => refresh(c, data));
	onCrust("chat:activated", (c) => refresh(c));

	selftestSteps.push(async ({ snap, wait }) => {
		await refresh();
		console.error(`SELFTEST thinking: options=${[...sel.options].map((o) => o.value)} value=${sel.value} hidden=${sel.hidden}`);
		// The composer row at a narrow width while Pi streams (Stop + Send visible): everything must fit inside the composer.
		const comp = $("#composer");
		const was = active.state.streaming;
		const hadHidden = sel.hidden;
		sel.hidden = false; // the check is about the widest case, even if this model has no levels
		comp.style.width = "380px";
		comp.style.alignSelf = "flex-start";
		active.state.streaming = true;
		$("#stop").hidden = false;
		await wait(300);
		const box = comp.getBoundingClientRect();
		const outside = ["#thinking-level", "#perm-mode", "#stop", "#send"].filter((q) => {
			const e = $(q);
			if (!e || e.hidden) return false;
			const r = e.getBoundingClientRect();
			return r.left < box.left - 1 || r.right > box.right + 1;
		});
		const rowTops = new Set(["#stop", "#send"].map((q) => Math.round($(q).getBoundingClientRect().top)));
		console.error(`SELFTEST composer 380px streaming: width=${Math.round(box.width)} outside=[${outside}] stop/send rows=${rowTops.size} -> ${!outside.length ? "OK" : "MISMATCH"}`);
		await snap("composer-380-streaming");
		comp.style.width = comp.style.alignSelf = "";
		active.state.streaming = was;
		$("#stop").hidden = !was;
		sel.hidden = hadHidden;
	});
})();
