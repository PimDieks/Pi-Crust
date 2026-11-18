# Day 1 with Pi Crust

For designers who have never used a coding agent. About ten minutes, no terminal needed.

Pi Crust is a workspace around **Pi**, the coding agent that does the work. You get your files, a live preview and a way to undo, in one window.

## 1. Install Pi Crust

Download `Pi-Crust-Setup-<version>.exe` from the [Releases page](https://github.com/PimDieks/Pi-Crust/releases) and run it. It installs for your user only and needs no admin rights. Windows may warn that the installer is not signed: choose **More info**, then **Run anyway**.

## 2. The setup checklist

The first time you open Pi Crust, a welcome view shows a short checklist. Each line has a mark and one button:

- `✓` is done.
- `○` still has to be done.
- `–` is optional, or Pi Crust can't tell.

| Line | What it means | The button |
|---|---|---|
| **Pi** | Pi is the agent. It has to be on this computer. | **Install Pi** |
| **Model provider** | Pi needs a model provider (an AI service) to think with. Sign in to the one you already pay for. | **Sign in** |
| **Git** | Pi Crust uses Git to show your changes and to undo them. | **Install Git** |
| **Project** | The folder you want to work on. | **Choose folder** |
| **Figma** (optional) | Lets Pi read what you select in Figma. You can do this later. | **Set up Figma** |

The highlighted button is the next thing to do. When the four required lines are done, **Start** turns on.

### What Install does

Before anything is installed, Pi Crust shows a list of exactly what it will install and where it comes from. Nothing starts until you choose **Install**. Windows may ask you to confirm. Pi Crust installs Node.js, Git and Pi only if they are missing, and changes nothing else on your computer.

If the install can't run, for example on a work laptop that blocks installs, the checklist shows the steps to do by hand. Ask your IT team to help with those. After that, choose **Check again**.

### Sign in

**Sign in** opens the list of model providers Pi can use (Claude, GitHub Copilot, ChatGPT, or a local model with Ollama). Choose the one you already pay for. A browser window opens for the sign-in. Pi Crust never sees your password.

### Choose a folder

Pick the folder of the project you want to work on. If it isn't a Git project yet, the line says so and offers **Make it a Git project**. That runs `git init` in the folder and nothing else. Nothing is added or committed, and your files stay as they are.

### Skip for now

You can skip the checklist. A small **Setup: 3 of 4** pill stays next to the model name in the chat until everything is done. Click it to open the checklist again.

## 3. The first task

After **Start**, a card above the message box walks you through the loop that Pi Crust is built for. It uses a little of your plan: two short messages.

1. **Ask Pi about your project.** Choose **Put the text in the box**, read it, and press Enter. Pi reads the folder and explains it.
2. **Let Pi change one file.** Same again. Pi adds one line to `README.md`. Open the **Changes** tab to see exactly what changed. Your other changes stay as they are.
3. **Undo it.** Hover your own message in the chat and click **Rewind**. Choose **Restore the files**. The line is gone again.

Pi Crust never sends a message for you: you press Enter. Each step ticks by itself when it really happened. **Hide** puts the card away, and you can bring it back from the checklist, the command palette or the Help menu.

## Ways back to setup

- The **Setup** pill in the chat header, while something is still to do.
- The command palette (Ctrl+K): **Setup checklist…** and **First task…**.
- Type `/setup` in the message box. It works even when Pi isn't installed.
- **Help**, then **Setup checklist** or **First task**.
- The **Open setup** button in a chat where Pi isn't installed.

## Where to get help

- The [README](../README.md) describes every part of the window.
- [SETUP.md](../SETUP.md) covers installing from source and updating.
- Something not working? Open an issue on the [project page](https://github.com/PimDieks/Pi-Crust/issues).
