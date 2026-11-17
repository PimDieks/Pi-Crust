# Pi Crust in Docker

Runs Pi Crust (Electron) in a Linux container on a virtual display. You use it in your browser.
Your projects are mounted at the same paths as on your computer, and your Pi setup (extensions, subagents, prompts,
skills, settings) is copied in, so it behaves like Pi Crust on your Mac.

## Start

From the pi-crust folder. `PROJECTS` is the folder with your repos (default `~/Documents`), `WORKSPACE` the repo to open first:

```bash
PROJECTS=~/Documents WORKSPACE=~/Documents/my-monorepo docker compose -f docker/compose.yml up --build -d
```

Open http://localhost:6080/. For a window without browser bars (Chrome):

```bash
open -na "Google Chrome" --args --app=http://localhost:6080/
```

- **Full screen:** hover the top-right corner and press *⛶ Full screen*. The app resizes to fill it. Esc and ⌘W then go
  to the app; hold Esc to leave full screen. The screen also follows the browser window size.
- **Keyboard:** ⌘ works as on the Mac (the page sends it as Ctrl, which is the shortcut key on Linux): ⌘C, ⌘V, ⌘A, ⌘Z, ⌘K…
- **Clipboard:** copying in the app puts the text on your Mac's clipboard; ⌘V pastes your Mac's clipboard into the app.
  The first paste may ask to allow clipboard access.
- **Links** the app opens (logins, "open in browser") open in a new tab on your Mac, or show in a banner with an *Open* button.

## Log in to the AI providers

Pick one:

- **In the app:** click the model name in the chat header → *Subscriptions* → **Connect** (Claude, GitHub Copilot,
  ChatGPT Plus/Pro). The sign-in page opens in your browser and comes back to the app by itself (the callback ports 53692
  and 1455 are published). Copilot shows a device code, already on your clipboard.
- **Reuse your Mac's login:** add `PI_IMPORT_AUTH=1` to the start command. On the first start the container copies
  `~/.pi/agent/auth.json`. Afterwards the two logins live separately; if one refreshes a rotating token (Claude,
  ChatGPT) the other may need a new login.
- **API keys:** `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY` or `OPENROUTER_API_KEY` in your shell before `up`.
- **In a terminal:** `/login` is a Pi command, so run it inside `pi`, not in a shell:

```bash
docker compose -f docker/compose.yml exec pi-crust pi
```

Logins and sessions stay in the `pi-home` volume across restarts.

## Reach services on your computer (other compose stacks, dev servers)

`HOST_PORTS` makes `localhost:<port>` inside the container reach that port on your Mac, so a repo's `localhost` config
works unchanged. For the my-monorepo stack (Postgres, Kafka, Kafka UI) and a dev server:

```bash
HOST_PORTS=5432,9092,8888,3000 PROJECTS=~/Documents WORKSPACE=~/Documents/my-monorepo docker compose -f docker/compose.yml up -d
```

Don't list a port that something inside the container listens on (for example a dev server Pi starts in the container).
Add `3845` for the Figma desktop MCP server.

## What is shared with your computer

| | |
|---|---|
| `PROJECTS` (default `~/Documents`) | mounted read-write at the same path |
| `~/.pi/agent` | mounted read-only; on every start `extensions`, `agents`, `prompts`, `skills`, `themes`, `settings.json`, `models.json`, `mcp.json`, `APPEND_SYSTEM.md`, `SYSTEM.md`, `AGENTS.md`, `keybindings.json` are copied in. Not: sessions, `bin/` (Mac binaries), browser profiles, logins (see `PI_IMPORT_AUTH`) |
| `~/.gitconfig` | read-only, for your git name and email; commit signing and the macOS keychain helper are turned off in the container |
| SSH agent | forwarded (Docker Desktop), for `git push` over SSH. HTTPS remotes that use the macOS keychain need a token in the container instead |

## Notes

- The page is published on `127.0.0.1` only, and a gate in front of it (`docker/gate.js`) only lets pages opened from
  localhost connect, so other websites can't reach the app. To open it under another name (e.g. a Tailscale name), add
  that name to `ALLOWED_HOSTS`. Raw VNC isn't published. `PORT=6081` runs a second copy (the login callback ports are fixed).
- While the container runs it holds ports 1455 and 53692 on your Mac, so a ChatGPT login in `pi` or the Codex CLI
  on the Mac fails until you stop it. OpenRouter's browser login uses a random port; paste the redirect URL instead.
- Electron runs as root with `--no-sandbox`. If it quits, the entrypoint starts it again (`PI_CRUST_RESTART=0` turns that off).
- `node_modules` in your repos were installed on macOS. Native packages (esbuild, Prisma, swc…) don't run in the
  Linux container, so run builds, tests and dev servers on your Mac and reach them through `HOST_PORTS`, or install
  separately in a copy of the repo inside the container.
- Not available: macOS-only features (global hotkey, Dock, voice input), MCP servers that start a Mac program (in your
  `mcp.json`: `figma-console`), and the browser-screenshot extension's "capture my open browser window" mode (URL mode
  works, with Chromium).
- Self-test in the container (repo at the same path on both sides):

```bash
docker run --rm --shm-size=1g -e PI_CRUST_SELFTEST=1 -e PI_CRUST_RESTART=0 -e PI_CRUST_CWD=$PWD -v $PWD:$PWD -v pi-crust_pi-home:/root/.pi -v ~/.pi/agent:/host-pi:ro -v ~/.gitconfig:/host-gitconfig:ro -v $PWD/out:/opt/pi-crust/out pi-crust
```
