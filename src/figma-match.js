// Matching the master components of a Figma file (component sets for variants, standalone components otherwise) to Storybook
// stories. UMD: `FigmaMatch` in the UI, `require("./figma-match")` in tests.
//  - isPrivate(name): names starting with "." or "_" are private in Figma and never get a story
//  - nameKeys(name) -> normalized names to compare: lowercase, alphanumerics only, last "/" segment, also without "Base"
//  - nodeKey(id) -> "123:456" for "123-456" or "123:456"; figmaNodeId(url) -> that, from a figma.com URL's node-id
//  - pageLabel("❖ Notification +") -> "Notification"; a story whose name matches a ❖ page (and no component) covers all components on that page
//  - matchStories(stories, components, files?) -> { byStory: { [storyId]: componentName }, matched: [component], unmatched: [component] }
//    stories: [{ id, title, name, importPath }]; files: { [storyId]: { componentFile, figmaUrl } } (optional, from storybook:resolve)
(function (root, make) {
	const api = make();
	if (typeof module === "object" && module.exports) module.exports = api;
	else root.FigmaMatch = api;
})(typeof window !== "undefined" ? window : globalThis, () => {
	const AFFIXES = ["base"];
	const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
	const isPrivate = (name) => /^[._]/.test(String(name || "").trim());

	function nameKeys(name) {
		const out = new Set();
		const segs = String(name || "").split("/");
		for (const raw of [segs[segs.length - 1], String(name || "")]) {
			const n = norm(raw);
			if (!n) continue;
			out.add(n);
			for (const a of AFFIXES) {
				if (n.startsWith(a) && n.length > a.length) out.add(n.slice(a.length));
				if (n.endsWith(a) && n.length > a.length) out.add(n.slice(0, -a.length));
			}
		}
		return [...out];
	}

	const nodeKey = (id) => {
		const m = /^(\d+)[-:](\d+)$/.exec(String(id || "").trim());
		return m ? `${m[1]}:${m[2]}` : "";
	};
	function figmaNodeId(url) {
		try {
			return nodeKey(new URL(String(url)).searchParams.get("node-id"));
		} catch {
			return "";
		}
	}

	const baseName = (p) => {
		const b = String(p || "").split(/[\\/]/).pop().replace(/\.(stories|story)(?=\.)/i, "").replace(/\.(tsx|ts|jsx|js|mjs|mdx)$/i, "");
		return b === "index" ? "" : b;
	};

	// "❖ Notification +" -> "Notification": design-system files keep one page per master component (with its variants and parts).
	const pageLabel = (page) => String(page || "").replace(/^[\s❖◆]+/, "").replace(/[\s+]+$/, "").trim();
	// Loose keys, tried last: without a generic last word, so the story "Input" finds "Input Field" and "Radio" finds "Radio Button".
	const LOOSE = ["field", "button", "control"];
	const looseKeys = (name) => nameKeys(name).flatMap((k) => LOOSE.filter((w) => k.endsWith(w) && k.length > w.length).map((w) => k.slice(0, -w.length)));

	function matchStories(stories, components, files = {}) {
		const comps = (components || []).filter((c) => c && c.name && !isPrivate(c.setName || c.name) && !isPrivate(c.name));
		const byName = new Map();
		const byNode = new Map();
		const byPage = new Map(); // key -> { label, comps }
		const byLoose = new Map();
		for (const c of comps) {
			for (const k of nameKeys(c.setName || c.name)) if (!byName.has(k)) byName.set(k, c);
			for (const k of looseKeys(c.setName || c.name)) if (!byLoose.has(k)) byLoose.set(k, c);
			const n = nodeKey(c.nodeId);
			if (n) byNode.set(n, c);
			const label = pageLabel(c.page);
			if (label && /^[\s]*[❖◆]/.test(String(c.page))) {
				for (const k of nameKeys(label)) {
					if (!byPage.has(k)) byPage.set(k, { label, comps: [] });
					byPage.get(k).comps.push(c);
				}
			}
		}
		const byStory = {};
		const used = new Set();
		for (const s of stories || []) {
			const f = files[s.id] || {};
			let hit = byNode.get(figmaNodeId(f.figmaUrl));
			if (!hit) {
				const title = String(s.title || "").split("/").pop();
				const keys = [...nameKeys(title), ...nameKeys(baseName(f.componentFile)), ...nameKeys(baseName(s.importPath))];
				for (const k of keys) if ((hit = byName.get(k))) break;
				if (!hit) {
					const page = keys.map((k) => byPage.get(k)).find(Boolean);
					if (page) {
						byStory[s.id] = page.label;
						for (const c of page.comps) used.add(c);
						continue;
					}
				}
				if (!hit) for (const k of keys) if ((hit = byLoose.get(k))) break;
			}
			if (hit) {
				byStory[s.id] = hit.setName || hit.name;
				used.add(hit);
			}
		}
		return { byStory, matched: comps.filter((c) => used.has(c)), unmatched: comps.filter((c) => !used.has(c)) };
	}

	return { isPrivate, nameKeys, nodeKey, figmaNodeId, baseName, pageLabel, matchStories };
});
