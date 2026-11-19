# Changelog

All notable changes to Pi Crust. Format after Keep a Changelog; versions follow semantic versioning.
A release tag is `vX.Y.Z` (pre-releases `vX.Y.Z-rc.N`) and must match `version` in `package.json`.
The section of a version becomes the text of its release.

## [Unreleased]

- **The Viewer has tabs and shows project files.** A row of up to 8 page tabs sits under the address bar (**+**, **×**, ⌘T, Ctrl+W or ⌥⌘W, ⌥⌘← and ⌥⌘→); the pages are remembered per project. The Viewer can show web pages (HTML), images and PDFs from the open project. Remembered web pages come back unloaded unless they are on localhost (a **Load** button loads one), a web page cannot open a project tab, and on a Mac ⌘W stays *Close window*. Open one by typing its project path in the address bar (with suggestions), from **Open in Viewer** in the tree's right-click menu or in the Editor's status bar, or by dropping a file on the Viewer. Project pages run like any web page, in their own session per project (your dev browser's logins are never sent to them). Only files of the open project are served: no `..`, no dot files or folders (`.git`, `.env`), no link that leads outside the project, no folder listing. The page you look at reloads by itself when its file or a file it loaded changes. See "Viewer" in the README.
- **The agent can show you a page.** Pi and Claude Agent get one tool, `show_in_viewer`, for a project file or a localhost address. It opens a new tab in the background (or marks the tab that already shows it), puts a small badge on the Viewer tab, and never takes your focus. Click the file name on the tool's card in the chat to jump to the page. The app checks every call with the address bar's rules (nothing outside the project, no dot folders, no other host), at most three new pages per turn, never more than 8 pages. It needs the permission that reading the file needs in the chat's mode and never asks a question of its own; a localhost address is allowed in every mode. For Claude Agent it is the only tool the app adds.
- **Commands in a Pi chat no longer see your secret-looking environment variables.** In a Pi chat a command printed two unrelated API keys from the Windows environment into the chat. Pi still keeps its own keys, but before each command runs the permission extension adds a prefix that removes every secret-looking variable (the same name rule as for Claude Agent chats), for that command only, by name. It works in every mode, Trusted included; the question and the chat still show the original command. It is written for Git Bash and other bash shells and for PowerShell; with any other shell and a secret-looking variable present, the command is not run. The new `commandEnvKeep` setting (the same for both agents, default empty) lists names a command may keep. Subagents, MCP servers and other extensions still get the whole environment; see the README.
- **Trusted is not remembered for new chats.** Plan, Ask before edits and Ask before commands are remembered as before. If the last mode you chose was Trusted, a new chat starts in Ask before commands, and so does a chat that comes back after an app restart. Switching a chat to Trusted affects that chat only. This holds for both agents.
- A second, optional agent: **Claude Agent**, powered by Claude. Pi stays the default. It needs your own Anthropic API key (usage is billed to your Anthropic account; no sign-in with a Claude subscription) and a one-time engine download of about 175 MB, checked before use. See "Claude Agent" in the README and SETUP.md.
- **New chat** is now a split button. A plain click starts a Pi chat as before; the small arrow next to it lets you pick Pi or Claude Agent for the new chat.
- Every chat shows its agent's name in a chip in the chat header. Claude Agent tabs get a small diamond before the title; Pi tabs look as before.
- A new Claude Agent chat opens with a setup card for the key and the engine. The message box is off, and says why, until both are done. The key can be changed or removed from the card, and from the Setup panel once you have started a Claude Agent chat. A wrong key is reported when you save it.
- The four permission modes and the approval prompt gate Claude Agent chats too. They are a safety net, not a sandbox, and on Windows the engine has no sandbox. The project's `CLAUDE.md` is read as instructions; the project's and your own Claude settings are not loaded. The key is kept in the operating system's protected store and out of the commands the agent runs.
- A Claude Agent chat shows an estimated cost and pauses at about 5 dollars. A card asks you to **Continue** or **Change limit** (also `claudeMaxBudgetUsd` in `settings.json`).
- Variables with secret-looking names (`..._KEY`, `..._SK`, `..._TOKEN`, `..._SECRET`, `..._PASSWORD`, `..._PASSPHRASE`, cookies, `AUTH`, webhook and connection URLs) in your environment are kept out of the commands a Claude Agent chat runs.
- Rewind and Fork work in Claude Agent chats. A rewound chat or a new fork that has no message yet comes back the same after a restart.
- Controls a Claude Agent chat cannot use (steering, the queue, `/clone`, `/export`, `/compact`, `/session`, `/name`, the advisor, Pi's subscriptions and Copilot quota) are shown off with a reason, or are absent.
- Earlier chats lists the saved chats of both agents. Chats you had open come back with their own agent after a restart.
- The phone view shows Pi chats only for now.
- The slash and @ menus now sit with a small gap above the message box instead of touching it. The reason a control is disabled shows in its own line under the chat and never covers the chat or a question.
- First launch shows a setup checklist: Pi, a model provider, Git, a project folder and (optional) Figma, each with one button. Pi Crust can install what is missing after you confirm the list, make a folder a Git project, and open the sign-in and Figma setup. **Skip for now** leaves a **Setup** pill in the chat header.
- A guided first task above the message box: ask Pi about the project, let it change one file, then undo it with Rewind. Each step ticks when it really happened, and nothing is sent for you.
- Ways back to setup: the pill, the command palette, `/setup` (works without Pi), a new **Help** menu, and an **Open setup** button where Pi is missing.
- A chat with no Pi installed says "Pi isn't installed yet" and opens setup, instead of "spawn pi ENOENT". Installing Pi while the app runs no longer needs a restart.
- A day-1 guide for designers: [docs/day-1.md](docs/day-1.md).
- Permission modes now ship with Pi Crust and are enforced by a bundled extension: Plan blocks edits and non-read-only commands, Ask before edits and Ask before commands ask first, Trusted checks nothing. A fresh install starts in Ask before commands. See "Permission modes" in the README for what each mode does and does not protect against.
- Files that change what git or Pi runs (`.git`, `.gitattributes`, `.gitmodules`, a root `HEAD`, `.pi`, Pi's folder) always ask. Paths are read the way Pi reads them (`file://`, Git Bash drive paths), network paths are never read-only, and wildcards make a command ask.
- The question shows exactly what runs: invisible characters and long runs of spaces are made visible, and a command or path too long to show is blocked. Answers: Allow once, Allow for this chat, Deny. Changing the mode cancels open questions.
- The mode selector (and the phone's) is disabled and says "Not enforced" when the extension did not load. The app switches modes with `/crust-mode` and tells you once about an old `permission-modes.ts` in `~/.pi/agent/extensions`.

## [0.2.0] - 2026-11-17

First versioned release.

- Installers are now built from a tagged version and published on the GitHub releases page.
- The installer is named `Pi-Crust-Setup-<version>.exe`, and the publisher is Nullvorm.
- Windows only for now.
