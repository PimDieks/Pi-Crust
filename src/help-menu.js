// The Help menu: ways back into setup, and the Day-1 guide. Kept apart from main.js so a test can read the menu it builds.
//  - Setup checklist: asks the window to open the welcome view ("onboarding:open" -> "setup")
//  - First task:      asks the window to show the first-task card ("onboarding:open" -> "first-task")
//  - Open the Day-1 guide: the guide in the project's repository on GitHub, in the system browser
"use strict";

const GUIDE_URL = "https://github.com/PimDieks/Pi-Crust/blob/main/docs/day-1.md";

function helpMenu({ send, openExternal }) {
	return {
		label: "Help",
		role: "help",
		submenu: [
			{ label: "Setup checklist", click: () => send("onboarding:open", "setup") },
			{ label: "First task", click: () => send("onboarding:open", "first-task") },
			{ type: "separator" },
			{ label: "Open the Day-1 guide", click: () => openExternal(GUIDE_URL) },
		],
	};
}

module.exports = { helpMenu, GUIDE_URL };
