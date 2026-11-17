# Pi Crust: setup on a new machine

## Prerequisites

- Node via nvm
- Pi installed and working in the terminal (`pi`), with your own `~/.pi/agent` setup

## Install

Put the folder at `~/Documents/pi-crust` (the launcher script expects that path), then:

```bash
cd ~/Documents/pi-crust && npm install && npx electron-rebuild -f -w node-pty
```

`node-pty` is native, so always build it on the machine itself.

## Start

```bash
cd ~/Documents/pi-crust && npm start
```

## Install as an app (macOS)

To get **Pi Crust** in Applications (Spotlight, the Dock), build it on this Mac and install it in one go:

```bash
cd ~/Documents/pi-crust && npm run update -- --app
```

That builds `Pi Crust.app` for this Mac (Apple silicon or Intel) and puts it in `/Applications` (or `~/Applications` if you can't write there; an existing `Pi Crust.app` in either place is replaced). The `pi-crust` launcher starts the installed app when there is one.

- `npm run dist:mac` builds a disk image instead: `dist/Pi Crust-<version>-<arch>.dmg`, to drag the app to Applications yourself or give to another Mac.
- The app is signed ad hoc, not with an Apple developer certificate. On the Mac that built it, it just opens. On another Mac, Gatekeeper says it's from an unidentified developer: right-click the app, choose Open, then Open again (or allow it under System Settings, Privacy & Security).
- The first time you use voice input, macOS asks for microphone access.
- It has to be built on a Mac: electron-builder can't build macOS apps on Windows.
- The app remembers the folder it was built from, so the **Update** button keeps working (see below). Keep that folder.

## Update

Install by cloning (`git clone https://github.com/PimDieks/Pi-Crust.git ~/Documents/pi-crust`) so you can pull updates.

**In the app:** when there are new commits on GitHub, **Pi Crust update available** shows in the notifications on the right, above the chat. Hover it to see the commits. Press **Update** and the update is prepared in the background while you keep working; nothing closes. Then choose **Restart now** (it asks first if chats are still working; they reopen after the restart) or **Later** (the new version is used the next time you start Pi Crust). For the installed `Pi Crust.app` it builds a new app in the background; Restart now swaps it in and opens it, Later swaps it in when you quit Pi Crust (log: `~/Library/Logs/pi-crust-update.log`). It checks at startup and every hour. If the button is greyed out, Pi Crust's own folder has uncommitted changes or unpushed commits; hover it for details.

**From a terminal:**

```bash
cd ~/Documents/pi-crust && npm run update
```

It pulls the latest commits (fast-forward only), runs `npm install` and rebuilds `node-pty` when the dependencies changed, rebuilds the installed `Pi Crust.app` if there is one (installed when Pi Crust quits, if it's running), and tells you to restart Pi Crust. It stops without changing anything if you have uncommitted changes or local commits. `npm run update -- --check` only shows what's new; `-- --force` reinstalls the dependencies anyway.

## Optional

- **Local plugins** (`src/local/`): every `.js` file in that folder is loaded when Pi Crust starts, and `*-main.js` files run in the main process. They run with the app's full rights and are not sandboxed. The folder is gitignored, so nothing in it is committed or shared. Only put your own files there.
- **Voice input**: `brew install whisper-cpp`, then put a whisper model in the app's data folder:

```bash
mkdir -p ~/Library/Application\ Support/pi-crust/models && curl -L -o ~/Library/Application\ Support/pi-crust/models/ggml-large-v3-turbo-q5_0.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin
```

- **Storybook "In Figma" filter**: the figma-console MCP server configured in `~/.pi/agent/mcp.json` (or `figmaConsoleMcp` in `settings.json`) and its Desktop Bridge plugin running in Figma.
- **Figma picker / Design compare**: Figma desktop with the desktop MCP server enabled (Dev Mode → Inspect).

### Remote access with Tailscale (optional)

To chat with Pi from your phone (see the README).

1. Install Tailscale on this Mac and on your phone, and sign in to the same account on both.
2. In the [Tailscale admin console](https://login.tailscale.com/admin/dns), on the DNS page, turn on **MagicDNS** and **HTTPS Certificates**.
3. In Pi Crust, open *Remote access…* in the palette and press *Set up Tailscale Serve*. Or run it yourself:

```bash
tailscale serve --bg --https=443 http://127.0.0.1:7391
```

To undo it:

```bash
tailscale serve --https=443 off
```

On Linux, let your user run Serve without sudo once: `sudo tailscale set --operator=$USER`.

If that port has Tailscale Funnel on or already serves something else, Pi Crust won't touch it: turn Funnel off or pick another port in the panel. When you change the port, Pi Crust removes only the mapping it made.

The phone only sees the chats you share, one by one: open a chat and choose *Use this chat from your phone* in the 📱 button's menu in the chat header (or in the palette). Chats started from the phone are shared automatically, and sharing is remembered per session.

Without Tailscale, the panel can also serve your Wi-Fi (plain http, no notifications). Pick the right network in the panel if you have more than one. A Wi-Fi pairing lasts 30 days and doesn't work in Tailscale mode.

## Windows

Everything below is for Windows 10 or 11 and PowerShell. The macOS steps above stay as they are.

### Prerequisites

- Node LTS from [nodejs.org](https://nodejs.org), or [nvm-windows](https://github.com/coreybutler/nvm-windows)
- [Git for Windows](https://git-scm.com/download/win)
- Pi, installed globally. npm 11 skips some install scripts unless you allow them:

```powershell
npm i -g @earendil-works/pi-coding-agent --allow-scripts=koffi,protobufjs,@google/genai
```

  Then start `pi` once and type `/login` inside it. If PowerShell's execution policy blocks `pi.ps1`, start it with `pi.cmd` instead.

### Install

Put the folder anywhere you like (the launcher finds it by itself), then:

```powershell
cd path\to\pi-crust
npm install
```

`node-pty` ships prebuilt binaries for Windows, so there is no rebuild step and you need no Visual Studio Build Tools.

npm 11 skips install scripts of packages you have not approved, so Electron's binary may not be downloaded. If `node_modules\electron\dist\electron.exe` is missing, run one of:

```powershell
node node_modules/electron/install.js
npm install-scripts approve electron
```

The second one remembers the approval for the next `npm install`. If it is not available in your npm, use the first.

### Start

```powershell
npm start
```

Or use the launcher: `pi-crust` shows the repo picker (or reopens the last repo), `pi-crust C:\some\repo` opens that repository.

To get `pi-crust` on your PATH and a **Pi Crust** entry in the Start Menu, run once (no admin needed, open a new terminal afterwards):

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1
```

Add `-WhatIf` to see what it would do first. If you move the folder, run it again.

### Install as an app

```powershell
npm run dist:win
```

Then run `dist\Pi Crust Setup x.y.z.exe`. It installs for your user only (no admin) to `%LOCALAPPDATA%\Programs\Pi Crust`, and adds a Start Menu and desktop shortcut called **Pi Crust**. Remove it from Windows Settings, Apps.

- The installer is not signed. Windows SmartScreen will warn: choose More info, then Run anyway.
- The build needs the same `npm install` as above. Do not run `electron-rebuild`; `node-pty` uses its prebuilt Windows binaries.
- npm 11 may skip the install scripts of `node-pty` and `electron-winstaller`. Both are fine to skip: the build does not need them.
- The first build downloads the Electron, NSIS and 7-Zip files it needs, so it needs internet.
- The app icon is `build\icon.svg`. After editing it, run `node scripts\make-icon.js` to regenerate `build\icon.png` (1024) and `build\icon.ico` (16 to 256, each size rendered from the SVG). It uses the repo's own Electron, no extra dependencies.
- Once installed, `pi-crust` starts the installed app. Without it, `pi-crust` falls back to the folder copy.
- If you ran `scripts\install-windows.ps1` before, its Start Menu shortcut has the same name. The installer replaces it with one for the installed app.

### Update

```powershell
cd path\to\pi-crust
npm run update
```

The **Update** button works here too (see [Update](#update)). For the installed app it pulls in the folder you built it from and builds a new installer in the background (a minute or two). **Restart now** then installs and starts the new version; with **Later** it installs when you quit Pi Crust. An app installed before the button existed doesn't have it yet: run `npm run update -- --app` once, and from then on use the button.

From a terminal it does the same as on macOS: it pulls, runs `npm install` when the dependencies changed and fetches `electron.exe` if npm skipped it. If the installed app (`%LOCALAPPDATA%\Programs\Pi Crust`) is there, it also rebuilds the installer and runs it silently, which closes a running Pi Crust and updates the installed copy. Add `-- --no-app` to skip that, or `-- --app` to build and install the app even when nothing was pulled.

### Logs and data

- Logs: `%LOCALAPPDATA%\pi-crust\logs\pi-crust-<date-time>.log` (errors in a matching `.err.log`). Each start with `pi-crust` writes its own pair and the newest 5 are kept.
- Data folder (settings, models): `%APPDATA%\pi-crust`
- The Terminal tab runs PowerShell.

### Optional

- **Voice input**: download the Windows release zip from [whisper.cpp releases](https://github.com/ggml-org/whisper.cpp/releases), unpack it and put the folder with `whisper-cli.exe` on your PATH. Then put a whisper model in the app's data folder:

```powershell
New-Item -ItemType Directory -Force "$env:APPDATA\pi-crust\models" | Out-Null; Invoke-WebRequest -Uri https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin -OutFile "$env:APPDATA\pi-crust\models\ggml-large-v3-turbo-q5_0.bin"
```

- **Storybook "In Figma" filter** and **Figma picker / Design compare**: same as on macOS (see the notes above). The MCP config lives in `%USERPROFILE%\.pi\agent`.

#### Remote access with Tailscale (optional)

Same steps as on macOS (see [Remote access with Tailscale](#remote-access-with-tailscale-optional)): install Tailscale on both devices, turn on MagicDNS and HTTPS Certificates in the admin console, then use *Remote access…* in Pi Crust.

- Pi Crust finds the CLI at `C:\Program Files\Tailscale\tailscale.exe`, or `tailscale.exe` on your PATH.
- By hand, in PowerShell: `& "C:\Program Files\Tailscale\tailscale.exe" serve --bg --https=443 http://127.0.0.1:7391`. To undo it, use the same command with `serve --https=443 off`.
- Wi-Fi mode: Windows asks once whether Pi Crust may use the network. Allow it for **Private** networks only.
- Closing the Pi Crust window quits the app and turns Remote off.

## Docker

Pi Crust also runs in a Linux container that you use in your browser, with your projects and Pi setup from this computer. Needs Docker Desktop:

```bash
PROJECTS=~/Documents WORKSPACE=~/Documents/some-repo docker compose -f docker/compose.yml up --build -d
```

Then open http://localhost:6080/. Logging in to the AI providers, full screen, the clipboard and reaching services on this computer (`HOST_PORTS`) are in [docker/README.md](docker/README.md).
