"use strict";
// storybook:resolve (storybook-main.js resolveStory) on a fixture project in the system temp folder. The design-stories selftest seeds the
// resolved files for its Card stories (the app's own folder has no such story file), so this is where the resolver itself is exercised.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { resolveStory } = require("../src/storybook-main");

function fixture() {
	const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crust-sbres-"));
	const proj = path.join(repo, "alex-app");
	fs.mkdirSync(path.join(proj, "src"), { recursive: true });
	fs.writeFileSync(path.join(proj, "package.json"), JSON.stringify({ name: "alex-app", devDependencies: { storybook: "^8.0.0" }, scripts: { storybook: "storybook dev -p 6006" } }));
	fs.writeFileSync(path.join(proj, "src", "Card.tsx"), "export function Card() { return null; }\n");
	fs.writeFileSync(
		path.join(proj, "src", "Card.stories.tsx"),
		[
			"import type { Meta, StoryObj } from '@storybook/react';",
			"import { Card } from './Card';",
			"const meta: Meta<typeof Card> = { title: 'Card', component: Card };",
			"export default meta;",
			"export const Default: StoryObj<typeof Card> = { parameters: { design: { type: 'figma', url: 'https://www.figma.com/design/FILEKEY/Acme?node-id=1-2' } } };",
			"export const WithImage: StoryObj<typeof Card> = { parameters: { design: { type: 'figma', url: 'https://www.figma.com/design/FILEKEY/Acme?node-id=1-9' } } };",
			"export const Plain: StoryObj<typeof Card> = {};",
			"",
		].join("\n"),
	);
	return { repo, projects: [{ dir: "alex-app" }] };
}

test("resolveStory finds the story file, the component, the export and its own Figma link", () => {
	const { repo, projects } = fixture();
	try {
		const base = { importPath: "./src/Card.stories.tsx", componentPath: "" };
		const d = resolveStory(repo, projects, { ...base, id: "card--default", name: "Default" });
		assert.deepStrictEqual(d, { storyFile: "alex-app/src/Card.stories.tsx", componentFile: "alex-app/src/Card.tsx", figmaUrl: "https://www.figma.com/design/FILEKEY/Acme?node-id=1-2", exportName: "Default" });
		const w = resolveStory(repo, projects, { ...base, id: "card--with-image", name: "With image" });
		assert.strictEqual(w.exportName, "WithImage");
		assert.strictEqual(w.figmaUrl, "https://www.figma.com/design/FILEKEY/Acme?node-id=1-9");
		// a story without its own link falls back to the first link in the file
		const p = resolveStory(repo, projects, { ...base, id: "card--plain", name: "Plain" });
		assert.strictEqual(p.exportName, "Plain");
		assert.strictEqual(p.figmaUrl, "https://www.figma.com/design/FILEKEY/Acme?node-id=1-2");
	} finally {
		fs.rmSync(repo, { recursive: true, force: true });
	}
});

test("resolveStory: a missing file gives empty fields, a path outside the repo is refused", () => {
	const { repo, projects } = fixture();
	try {
		const none = resolveStory(repo, projects, { id: "x--y", name: "Y", importPath: "./src/Nope.stories.tsx", componentPath: "" });
		assert.deepStrictEqual(none, { storyFile: "", componentFile: "", figmaUrl: "", exportName: "" });
		const outside = path.join(path.dirname(repo), "pi-crust-sbres-outside.stories.tsx");
		fs.writeFileSync(outside, "export const A = {};\n");
		try {
			const r = resolveStory(repo, projects, { id: "a--a", name: "A", importPath: path.relative(path.join(repo, "alex-app"), outside), componentPath: "" });
			assert.strictEqual(r.storyFile, "");
		} finally {
			fs.rmSync(outside, { force: true });
		}
	} finally {
		fs.rmSync(repo, { recursive: true, force: true });
	}
});
