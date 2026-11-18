# Changelog

All notable changes to Pi Crust. Format after Keep a Changelog; versions follow semantic versioning.
A release tag is `vX.Y.Z` (pre-releases `vX.Y.Z-rc.N`) and must match `version` in `package.json`.
The section of a version becomes the text of its release.

## [Unreleased]

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
