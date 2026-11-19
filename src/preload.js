// Narrow bridge between the sandboxed UI and the main process.
const { contextBridge, ipcRenderer, webUtils } = require("electron");

const on = (channel) => (fn) => {
	const handler = (_e, payload) => fn(payload);
	ipcRenderer.on(channel, handler);
	return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld("crust", {
	platform: process.platform,
	info: () => ipcRenderer.invoke("app:info"),
	focusUi: () => ipcRenderer.send("ui:focus"),
	onShortcut: on("app:shortcut"),
	repos: {
		list: () => ipcRenderer.invoke("repos:list"),
		browse: () => ipcRenderer.invoke("repos:browse"),
		open: (p) => ipcRenderer.invoke("repos:open", p),
		onChanged: on("repo:changed"),
		uiReady: () => ipcRenderer.invoke("ui:ready"),
		initGitPlan: () => ipcRenderer.invoke("repos:initGitPlan"), // { ok, folder, token, error }: the folder for the confirm, and the one-time token for it
		initGit: (token) => ipcRenderer.invoke("repos:initGit", { token }), // `git init` in that folder; main refuses without the token from initGitPlan
	},
	pi: {
		send: (chatId, record) => ipcRenderer.invoke("pi:send", chatId, record),
		restart: (chatId, sessionFile) => ipcRenderer.invoke("pi:restart", chatId, sessionFile),
		openInMain: (chatId) => ipcRenderer.invoke("pi:openInMain", chatId),
		newChat: (sessionFile, opts, agentId) => ipcRenderer.invoke("pi:newChat", sessionFile, opts, agentId),
		forkChat: (chatId, o) => ipcRenderer.invoke("pi:forkChat", chatId, o), // a Claude Agent chat's fork in a new tab: { entryId?, title } -> { ok, chatId, text, title }
		sessionFile: (chatId, file) => ipcRenderer.invoke("pi:sessionFile", chatId, file),
		activeChat: (chatId) => ipcRenderer.invoke("pi:activeChat", chatId),
		stop: (chatId) => ipcRenderer.invoke("pi:stop", chatId),
		heldTake: (chatId, i, text) => ipcRenderer.invoke("pi:heldTake", chatId, i, text),
		held: (chatId) => ipcRenderer.invoke("pi:held", chatId),
		oldCopy: () => ipcRenderer.invoke("pi:oldCopy"),
		revealOldCopy: () => ipcRenderer.invoke("pi:revealOldCopy"),
		selftestOldCopy: () => ipcRenderer.invoke("pi:selftestOldCopy"),
		onHeld: on("pi:held"),
		closeChat: (chatId) => ipcRenderer.invoke("pi:closeChat", chatId),
		onRecord: on("pi:record"),
		onStderr: on("pi:stderr"),
		onExit: on("pi:exit"),
		onUiResolved: on("pi:uiResolved"),
		onStarted: on("pi:started"),
		onReady: on("pi:ready"),
	},
	claude: {
		// The Claude Agent's first-use setup (claude-setup-main.js). The key goes in once and never comes back: state() holds no key.
		state: () => ipcRenderer.invoke("claude:state"),
		saveKey: (key) => ipcRenderer.invoke("claude:saveKey", key),
		removeKey: () => ipcRenderer.invoke("claude:removeKey"),
		enginePlan: (chatId) => ipcRenderer.invoke("claude:enginePlan", chatId),
		engineDownload: (token, chatId) => ipcRenderer.invoke("claude:engineDownload", token, chatId),
		engineCancel: () => ipcRenderer.invoke("claude:engineCancel"),
		setLimit: (usd) => ipcRenderer.invoke("claude:setLimit", usd),
		fakeSet: (cmd) => ipcRenderer.invoke("claude:fakeSet", cmd), // self-test only: main registers it only with the test switches
		onSetup: on("claude:setup"),
	},
	app: {
		selftestRun: ipcRenderer.sendSync("app:isSelftestRun") === true, // fixed by the main process; a test step cannot switch it off
		isFocused: () => ipcRenderer.invoke("app:isFocused"),
		badge: (n) => ipcRenderer.invoke("app:badge", n),
		show: () => ipcRenderer.invoke("app:show"),
		bounce: () => ipcRenderer.invoke("app:bounce"),
		onFocus: on("app:focus"),
	},
	mendix: {
		detect: () => ipcRenderer.invoke("mendix:detect"),
		start: () => ipcRenderer.invoke("mendix:start"),
		rebuild: () => ipcRenderer.invoke("mendix:rebuild"),
		stop: () => ipcRenderer.invoke("mendix:stop"),
		resetDb: () => ipcRenderer.invoke("mendix:resetDb"),
		logs: () => ipcRenderer.invoke("mendix:logs"),
		copyPassword: () => ipcRenderer.invoke("mendix:copyPassword"),
		selftestFake: (opts) => ipcRenderer.invoke("mendix:selftestFake", opts),
		onStatus: on("mendix:status"),
		onLog: on("mendix:log"),
	},
	appUpdate: {
		status: () => ipcRenderer.invoke("appUpdate:status"),
		check: () => ipcRenderer.invoke("appUpdate:check"),
		run: () => ipcRenderer.invoke("appUpdate:run"),
		restart: () => ipcRenderer.invoke("appUpdate:restart"),
		download: () => ipcRenderer.invoke("appUpdate:run"),
		openNotes: () => ipcRenderer.invoke("appUpdate:openNotes"),
		copyDetails: () => ipcRenderer.invoke("appUpdate:copyDetails"),
		onStatus: on("appUpdate:status"),
	},
	clipboard: { write: (text) => ipcRenderer.invoke("clipboard:write", text) },
	fs: {
		list: (rel) => ipcRenderer.invoke("fs:list", rel),
		index: () => ipcRenderer.invoke("fs:index"),
		gitStatus: (main, chatId) => ipcRenderer.invoke("git:status", main, chatId),
		openInEditor: (rel) => ipcRenderer.invoke("fs:openInEditor", rel),
		read: (rel) => ipcRenderer.invoke("fs:read", rel),
		stat: (rel) => ipcRenderer.invoke("fs:stat", rel),
		write: (rel, content) => ipcRenderer.invoke("fs:write", rel, content),
		onChanged: on("fs:changed"),
	},
	git: {
		diff: (chatId, rel, status) => ipcRenderer.invoke("git:diff", chatId, rel, status),
		original: (chatId, rel, status) => ipcRenderer.invoke("git:original", chatId, rel, status),
		discard: (chatId, rel, status) => ipcRenderer.invoke("git:discard", chatId, rel, status),
		commit: (chatId, message, push) => ipcRenderer.invoke("git:commit", chatId, message, push),
		push: (chatId) => ipcRenderer.invoke("git:push", chatId),
		info: (chatId) => ipcRenderer.invoke("git:info", chatId),
		log: (opts) => ipcRenderer.invoke("git:log", opts),
		refsStamp: () => ipcRenderer.invoke("git:refsStamp"),
		show: (hash) => ipcRenderer.invoke("git:show", hash),
	},
	sessions: {
		list: () => ipcRenderer.invoke("sessions:list"),
	},
	term: {
		start: (id, cols, rows) => ipcRenderer.invoke("term:start", id, cols, rows),
		input: (id, data) => ipcRenderer.invoke("term:input", id, data),
		resize: (id, cols, rows) => ipcRenderer.invoke("term:resize", id, cols, rows),
		kill: (id) => ipcRenderer.invoke("term:kill", id),
		onData: on("term:data"),
		onExit: on("term:exit"),
		onProc: on("term:proc"),
	},
	browser: {
		setBounds: (b) => ipcRenderer.invoke("browser:bounds", b),
		hide: (hidden, reason) => ipcRenderer.invoke("browser:hide", hidden, reason),
		navigate: (url) => ipcRenderer.invoke("browser:navigate", url),
		openSite: (url) => ipcRenderer.invoke("browser:openSite", url), // a page the app opens (story, Mendix): a tab on that site, else a new one -> { ok, tabId, reused } | { ok: false, message }
		onAgentShown: on("browser:agentShown"), // { chatId, tabId, label, kind, reused, active }: the agent showed a page in a background tab (show_in_viewer)
		focusShown: (target) => ipcRenderer.invoke("browser:focusShown", target), // the chat's tool card was clicked: the tab that shows `target` becomes the active tab -> { ok } | { ok: false, message }
		onNotice: on("browser:notice"), // { message }: a reason for the Viewer's reason line (a page the app could not open, no tab free)
		suggest: (text) => ipcRenderer.invoke("browser:suggest", text), // { items: [{ path, kind }] }: project files that match the typed text, at most 8
		openFile: (arg) => ipcRenderer.invoke("browser:openFile", arg), // { rel } (tree, Editor) or { abs } (a dropped file) -> { ok, tabId, path, kind, reused } | { ok: false, message }; main re-checks the path
		// The real path of a File from a drop (Electron's webUtils; File.path is gone). Main checks it again before anything opens.
		pathOf: (file) => {
			try { return webUtils.getPathForFile(file) || ""; } catch { return ""; }
		},
		tabs: () => ipcRenderer.invoke("browser:tabs"),
		createTab: (address) => ipcRenderer.invoke("browser:tabCreate", address),
		activateTab: (id) => ipcRenderer.invoke("browser:tabActivate", id),
		closeTab: (id) => ipcRenderer.invoke("browser:tabClose", id),
		loadTab: (id) => ipcRenderer.invoke("browser:tabLoad", id), // the Load button of a remembered web address that was not loaded -> { ok } | { ok: false }
		setTheme: (setting, bg) => ipcRenderer.invoke("browser:theme", setting, bg),
		pick: (opts) => ipcRenderer.invoke("browser:pick", opts),
		insertCss: (css) => ipcRenderer.invoke("browser:insertCss", css),
		removeCss: (key) => ipcRenderer.invoke("browser:removeCss", key),
		action: (a) => ipcRenderer.invoke("browser:action", a),
		scheme: (value) => ipcRenderer.invoke("browser:scheme", value),
		target: () => ipcRenderer.invoke("browser:target"),
		forceState: (opts) => ipcRenderer.invoke("browser:forceState", opts),
		imageZoom: (mode) => ipcRenderer.invoke("browser:imageZoom", mode),
		onTabLeft: on("browser:tabLeft"),
		onTarget: on("browser:target"),
		onState: on("browser:state"),
		onError: on("browser:error"),
	},
	figma: {
		pickSelection: () => ipcRenderer.invoke("figma:pickSelection"),
		setFileFromText: (text) => ipcRenderer.invoke("figma:setFileFromText", text),
		file: () => ipcRenderer.invoke("figma:file"),
		status: () => ipcRenderer.invoke("figma:status"),
		test: () => ipcRenderer.invoke("figma:test"),
		setFile: (link) => ipcRenderer.invoke("figma:setFile", link),
		openHelp: () => ipcRenderer.invoke("figma:openHelp"),
		stubMode: (mode, o) => ipcRenderer.invoke("figma:stubMode", mode, o), // selftest only
		screenshot: () => ipcRenderer.invoke("figma:screenshot"),
	},
	design: {
		tokens: () => ipcRenderer.invoke("design:tokens"),
		inspect: (selector) => ipcRenderer.invoke("design:inspect", selector),
		untag: () => ipcRenderer.invoke("design:untag"),
		figmaVariables: () => ipcRenderer.invoke("design:figmaVariables"),
		tokensFile: () => ipcRenderer.invoke("design:tokensFile"),
	},
	worktree: {
		create: (o) => ipcRenderer.invoke("worktree:create", o),
		list: () => ipcRenderer.invoke("worktree:list"),
		status: (cwd) => ipcRenderer.invoke("worktree:status", cwd),
		remove: (o) => ipcRenderer.invoke("worktree:remove", o),
		selftestInfo: (chatId) => ipcRenderer.invoke("worktree:selftestInfo", chatId),
		selftestWrite: (cwd, name, text) => ipcRenderer.invoke("worktree:selftestWrite", cwd, name, text),
		selftestDeleteBranch: (branch) => ipcRenderer.invoke("worktree:selftestDeleteBranch", branch),
		selftestExists: (cwd) => ipcRenderer.invoke("worktree:selftestExists", cwd),
	},
	// Machine-local plugins (src/local/): only `local:*` channels.
	local: {
		invoke: (channel, ...args) =>
			typeof channel === "string" && channel.startsWith("local:")
				? ipcRenderer.invoke(channel, ...args)
				: Promise.reject(new Error("Only local: channels are allowed")),
	},
	storybook: {
		detect: () => ipcRenderer.invoke("storybook:detect"),
		setUrl: (url) => ipcRenderer.invoke("storybook:setUrl", url),
		resolve: (story) => ipcRenderer.invoke("storybook:resolve", story),
	},
	figmaBridge: {
		components: (o) => ipcRenderer.invoke("figmaBridge:components", o),
	},
	checkpoints: {
		create: (o) => ipcRenderer.invoke("checkpoints:create", o),
		list: (o) => ipcRenderer.invoke("checkpoints:list", o),
		tag: (id, o, chatId) => ipcRenderer.invoke("checkpoints:tag", id, o, chatId),
		preview: (id, chatId) => ipcRenderer.invoke("checkpoints:preview", id, chatId),
		restore: (id, chatId) => ipcRenderer.invoke("checkpoints:restore", id, chatId),
		copy: (from, to, beforeAt, chatId) => ipcRenderer.invoke("checkpoints:copy", from, to, beforeAt, chatId),
		clear: (chatId) => ipcRenderer.invoke("checkpoints:clear", chatId),
	},
	snap: {
		live: (o) => ipcRenderer.invoke("snap:live", o),
		url: (url, o) => ipcRenderer.invoke("snap:url", url, o),
		get: (id, thumb) => ipcRenderer.invoke("snap:get", id, thumb),
		list: (filter) => ipcRenderer.invoke("snap:list", filter),
		tag: (id, tags) => ipcRenderer.invoke("snap:tag", id, tags),
		delete: (id) => ipcRenderer.invoke("snap:delete", id),
		same: (a, b) => ipcRenderer.invoke("snap:same", a, b),
		selftestLoad: (html) => ipcRenderer.invoke("snap:selftestLoad", html),
	},
	voice: {
		status: () => ipcRenderer.invoke("voice:status"),
		transcribe: (wav, lang) => ipcRenderer.invoke("voice:transcribe", wav, lang),
		askMic: () => ipcRenderer.invoke("voice:askMic"),
	},
	subs: {
		status: () => ipcRenderer.invoke("subs:status"),
		logout: (provider) => ipcRenderer.invoke("subs:logout", provider),
		login: (provider) => ipcRenderer.invoke("subs:login", provider),
		loginAnswer: (id, value) => ipcRenderer.invoke("subs:login-answer", id, value),
		loginCancel: () => ipcRenderer.invoke("subs:login-cancel"),
		onLoginState: on("subs:login-state"),
		ollamaSync: () => ipcRenderer.invoke("subs:ollama-sync"),
		ollamaRemove: () => ipcRenderer.invoke("subs:ollama-remove"),
	},
	health: {
		check: (o) => ipcRenderer.invoke("health:check", o),
		recheck: (o) => ipcRenderer.invoke("health:recheck", o),
		onboarding: () => ipcRenderer.invoke("health:onboarding"),
		onboardingSet: (key, value) => ipcRenderer.invoke("health:onboardingSet", key, value),
		stubSet: (s) => ipcRenderer.invoke("health:stubSet", s), // selftest only
		installPlan: (o) => ipcRenderer.invoke("health:installPlan", o), // { needs, plan: { ok, steps, lines, text, manual } }: the list for the confirm
		install: (o) => ipcRenderer.invoke("health:install", o), // after the confirm, { token } from installPlan: { ok, error, blocked, changed, cancelled, manual, details, health }
		installCancel: () => ipcRenderer.invoke("health:installCancel"), // stops a running install
		onRow: on("health:row"), // a row of the view as soon as its facts are in, while a check is still running
		onOpen: on("onboarding:open"), // from the Help menu: "setup" | "first-task"
		onInstallProgress: on("health:install-progress"), // { kind: start | step | line... | done | fail | end, id, text }
	},
	remote: {
		status: () => ipcRenderer.invoke("remote:status"),
		setEnabled: (on) => ipcRenderer.invoke("remote:setEnabled", on),
		share: (chatId, on) => ipcRenderer.invoke("remote:share", chatId, on),
		configure: (cfg) => ipcRenderer.invoke("remote:configure", cfg),
		newPairing: () => ipcRenderer.invoke("remote:newPairing"),
		cancelPairing: () => ipcRenderer.invoke("remote:cancelPairing"),
		unpair: (id) => ipcRenderer.invoke("remote:unpair", id),
		setupTailscale: () => ipcRenderer.invoke("remote:setupTailscale"),
		openExternal: (url) => ipcRenderer.invoke("remote:openExternal", url),
		onStatus: on("remote:status"),
		onChatSettings: on("remote:chatSettings"),
	},
	selftest: {
		onPrompt: on("selftest:prompt"),
		done: () => ipcRenderer.send("selftest:done"),
		capture: (name, crop) => ipcRenderer.invoke("selftest:capture", name, crop),
		zoom: (level) => ipcRenderer.invoke("selftest:zoom", level),
		resize: (w, h) => ipcRenderer.invoke("selftest:resize", w, h),
		bounds: () => ipcRenderer.invoke("selftest:bounds"),
		focusEmulation: (on) => ipcRenderer.invoke("selftest:focusEmulation", on),
		viewerTabs: (op) => ipcRenderer.invoke("viewertabs:selftest", op), // selftest only: the main side answers only in a selftest run
		viewerReload: (op) => ipcRenderer.invoke("viewerreload:selftest", op), // selftest only
		viewerAgent: (op) => ipcRenderer.invoke("vieweragent:selftest", op), // selftest only: the main side answers only in a selftest run
		viewerOpen: (op) => ipcRenderer.invoke("vieweropen:selftest", op), // selftest only: the main side answers only in a selftest run
		viewerFiles: () => ipcRenderer.invoke("viewerfiles:selftest"), // selftest only: the main side answers only in a selftest run
	},
});
