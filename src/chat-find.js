// Find in chat (⌘F): a find bar pinned to the top of the messages, highlights via the CSS Custom Highlight API
// (no DOM changes).
"use strict";

(() => {
	const host = $("#messages-host");
	const ICON = (d) => `<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
	const iconBtn = (label, d) => {
		const b = el("button", "icon");
		b.type = "button";
		b.title = label;
		b.setAttribute("aria-label", label);
		b.innerHTML = ICON(d);
		return b;
	};

	const bar = el("div", "find-bar");
	bar.setAttribute("role", "search");
	bar.setAttribute("aria-label", "Find in chat");
	bar.hidden = true;
	const input = el("input");
	input.type = "text";
	input.placeholder = "Find in chat";
	input.spellcheck = false;
	input.setAttribute("aria-label", "Find in chat");
	const count = el("span", "find-count", "");
	count.setAttribute("aria-live", "polite");
	const prev = iconBtn("Previous match (Shift+Enter)", '<path d="M4.5 9.5L8 6l3.5 3.5"/>');
	const next = iconBtn("Next match (Enter)", '<path d="M4.5 6.5L8 10l3.5-3.5"/>');
	const close = iconBtn("Close (Esc)", '<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>');
	bar.append(input, count, prev, next, close);
	host.prepend(bar);

	let ranges = [];
	let idx = 0;
	let timer = 0;
	const supported = typeof CSS !== "undefined" && CSS.highlights && typeof Highlight !== "undefined";

	function clearHighlights() {
		if (!supported) return;
		CSS.highlights.delete("chat-find");
		CSS.highlights.delete("chat-find-current");
	}

	function search(keep = false) {
		const q = input.value;
		const root = active?.el;
		ranges = [];
		if (q && root) {
			const needle = q.toLowerCase();
			const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
				acceptNode: (n) => (n.parentElement?.closest("script, style, [hidden], .code-actions, .turn-actions") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
			});
			for (let n = walker.nextNode(); n; n = walker.nextNode()) {
				const text = n.nodeValue.toLowerCase();
				for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + needle.length)) {
					const r = new Range();
					r.setStart(n, i);
					r.setEnd(n, i + q.length);
					ranges.push(r);
				}
			}
		}
		if (!keep || idx >= ranges.length) idx = 0;
		paint(!keep);
	}

	function paint(scrollTo) {
		count.textContent = !input.value ? "" : ranges.length ? `${idx + 1} / ${ranges.length}` : "0 / 0";
		bar.classList.toggle("none", !!input.value && !ranges.length);
		prev.disabled = next.disabled = !ranges.length;
		if (!supported) return;
		clearHighlights();
		if (!ranges.length) return;
		CSS.highlights.set("chat-find", new Highlight(...ranges));
		CSS.highlights.set("chat-find-current", new Highlight(ranges[idx]));
		if (scrollTo) {
			// A match inside a collapsed tool card: open it first, or there is nothing to scroll to.
			const target = ranges[idx].startContainer.parentElement;
			for (let d = target?.closest("details"); d; d = d.parentElement?.closest("details")) d.open = true;
			target?.scrollIntoView({ block: "center" });
		}
	}

	function step(dir) {
		if (!ranges.length) return;
		idx = (idx + dir + ranges.length) % ranges.length;
		paint(true);
	}

	function openBar() {
		bar.hidden = false;
		input.focus();
		input.select();
		if (input.value) search();
	}
	function closeBar() {
		bar.hidden = true;
		ranges = [];
		clearHighlights();
		$("#input").focus();
	}
	window.openChatFind = openBar;

	input.addEventListener("input", () => search());
	input.addEventListener("keydown", (e) => {
		if (e.key === "Enter") {
			e.preventDefault();
			step(e.shiftKey ? -1 : 1);
		} else if (e.key === "Escape") {
			e.preventDefault();
			e.stopPropagation();
			closeBar();
		}
	});
	prev.onclick = () => step(-1);
	next.onclick = () => step(1);
	close.onclick = closeBar;

	window.addEventListener(
		"keydown",
		(e) => {
			if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== "f") return;
			if (e.target.closest?.(".monaco-editor, .xterm")) return;
			if (!$("#modal-backdrop").hidden) return; // a dialog is open
			e.preventDefault();
			e.stopPropagation();
			openBar();
		},
		true,
	);

	// Keep results current: when the chat changes, and (debounced) while it streams in.
	onCrust("chat:activated", () => !bar.hidden && search());
	onCrust("chat:cleared", () => !bar.hidden && search());
	new MutationObserver((muts) => {
		if (muts.every((m) => bar.contains(m.target))) return; // our own count text
		if (bar.hidden || !input.value) return;
		clearTimeout(timer);
		timer = setTimeout(() => search(true), 250);
	}).observe(host, { childList: true, subtree: true, characterData: true, attributeFilter: ["hidden"] });

	selftestSteps.push(async ({ snap, wait }) => {
		switchTab("browser");
		openBar();
		input.value = "folder";
		search();
		await wait(400);
		console.error(`SELFTEST find: "folder" -> ${ranges.length} matches -> ${ranges.length ? "OK" : "MISMATCH"}`);
		await snap("find");
		const was = themeSetting();
		setTheme(currentTheme() === "dark" ? "light" : "dark");
		await wait(500);
		await snap(`find-${currentTheme()}`);
		setTheme(was);
		await wait(400);
		closeBar();
	});
})();
