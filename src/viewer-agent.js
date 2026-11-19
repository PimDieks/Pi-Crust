// The agent's tool show_in_viewer, the UI side (spec: Viewer tabs and project files, section E Q2 and task 13). The main process opens the page in a
// background tab (viewer-agent-main.js) and tells us with "browser:agentShown"; nothing here decides what may be shown, and nothing here takes focus.
//   - A small badge on the Viewer tab in the main tab bar counts the pages the agent showed since the person last looked at the Viewer. It is not
//     shown while the Viewer is the tab in view, and it clears the moment the Viewer is shown (switchTab calls seen()).
//   - The tool's card in the chat (renderer.js toolCard) names the file; clicking that name switches to the Viewer tab that shows it.
"use strict";

(() => {
	const badge = $("#viewer-badge");
	const TOOL_NAMES = new Set(["show_in_viewer", "mcp__pi-crust__show_in_viewer"]);
	let unseen = 0;

	function paint() {
		badge.textContent = unseen > 0 ? String(Math.min(unseen, 9)) + (unseen > 9 ? "+" : "") : "";
		const msg = unseen > 0 ? `${unseen} new ${unseen === 1 ? "page" : "pages"} from the agent` : "";
		badge.title = msg;
		const btn = badge.closest("button");
		if (btn) {
			if (msg) btn.setAttribute("aria-label", `Viewer, ${msg}`);
			else btn.removeAttribute("aria-label");
		}
	}

	// The agent showed a page. A reused tab that is the one in view needs no badge; a page shown while the Viewer is in view needs none either
	// (the person sees the new tab in the row, marked as updated).
	crust.browser.onAgentShown?.((ev) => {
		if (!ev || (ev.reused && ev.active)) return;
		if (typeof activeTab !== "undefined" && activeTab === "browser") return;
		unseen++;
		paint();
	});

	// The Viewer is shown: the person looks.
	function seen() {
		if (!unseen) return;
		unseen = 0;
		paint();
	}

	const isTool = (name) => TOOL_NAMES.has(String(name));

	// The tool card's file name becomes a button: switch to the Viewer tab that shows it.
	function decorate(t, args) {
		const target = args && typeof args.target === "string" ? args.target : "";
		if (!target || !t || !t.argEl || t.argEl.dataset.viewerLink) return;
		t.argEl.dataset.viewerLink = "1";
		t.argEl.classList.add("tview");
		t.argEl.setAttribute("role", "button");
		t.argEl.tabIndex = 0;
		const go = async (e) => {
			e.preventDefault();
			e.stopPropagation(); // the card's own open and close is for the rest of its summary
			if (t.d.classList.contains("err")) return toast("Nothing was shown for this call.", "info");
			const r = await crust.browser.focusShown(target);
			if (r && r.ok) switchTab("browser");
			else toast((r && r.message) || "That page is not open any more.", "info");
		};
		t.argEl.addEventListener("click", go);
		t.argEl.addEventListener("keydown", (e) => {
			if (e.key === "Enter" || e.key === " ") go(e);
		});
		t.argEl.title = `Show ${target} in the Viewer`;
	}

	window.viewerAgent = { isTool, decorate, seen, unseen: () => unseen };
})();
