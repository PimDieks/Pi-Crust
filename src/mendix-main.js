// Run a Mendix app from the open repo (UI: mendix.js, the bar in the Viewer tab). Builds it with the pinned
// docker-mendix-buildpack, runs it next to a Postgres container for this repo, waits until it answers, and tells
// the UI the URL. The pure parts (detection, names, docker arguments, error texts) are in mendix-logic.js.
// Secrets: passwords never go on a command line (`-e NAME`, the value sits in the docker child's environment) and
// never into the log buffer (redacted).
"use strict";

const { spawn, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const L = require("./mendix-logic");
const { killTree } = require("./kill-tree");

const IS_WIN = process.platform === "win32";
const KILL_GRACE_MS = 5000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cancelled extends Error {}

function register(ctx) {
	const { ipcMain, app } = ctx;
	const base = path.join(app.getPath("userData"), "mendix");

	// ---- the docker runner (the self-test swaps in a fake with the same interface) ----
	function createDockerRunner({ log }) {
		let dockerBin = null;
		const docker = () => (dockerBin ||= L.dockerCandidates(process.platform).find((c) => c === "docker" || fs.existsSync(c)) || "docker");
		const envFor = (extra) => {
			const env = { ...ctx.env, ...extra };
			const bin = docker();
			if (path.isAbsolute(bin)) {
				const key = Object.keys(env).find((k) => k.toLowerCase() === "path") || "PATH";
				env[key] = `${path.dirname(bin)}${path.delimiter}${env[key] || ""}`;
			}
			return env;
		};
		// Runs a command; resolves { code, out, error } and never rejects. `log: true` streams the output to the log.
		function exec(cmd, args, { env, cwd, stream = false, signal, timeout } = {}) {
			return new Promise((resolve) => {
				let out = "";
				let child;
				try {
					child = spawn(cmd, args, { env: envFor(env), cwd, detached: !IS_WIN, windowsHide: true });
				} catch (e) {
					return resolve({ code: -1, out: "", error: e });
				}
				let tail = "";
				const feed = (d) => {
					const s = d.toString();
					out = (out + s).slice(-20000);
					if (!stream) return;
					tail += s;
					const lines = tail.split(/\r?\n|\r/);
					tail = lines.pop();
					const ok = lines.filter((l) => l.trim());
					if (ok.length) log(ok);
				};
				child.stdout.on("data", feed);
				child.stderr.on("data", feed);
				// Cancel: SIGINT to the process group first (build.py and docker clean up on it), SIGKILL after a grace period.
				let killTimer = null;
				const kill = () => {
					try {
						if (IS_WIN) return killTree(child, true);
						process.kill(-child.pid, "SIGINT");
						killTimer = setTimeout(() => {
							try {
								killTree(child, true);
							} catch {}
						}, KILL_GRACE_MS);
					} catch {}
				};
				signal?.addEventListener("abort", kill, { once: true });
				const timer = timeout && setTimeout(kill, timeout);
				child.on("error", (error) => {
					clearTimeout(timer);
					clearTimeout(killTimer);
					resolve({ code: -1, out, error });
				});
				child.on("close", (code) => {
					clearTimeout(timer);
					clearTimeout(killTimer);
					signal?.removeEventListener("abort", kill);
					if (stream && tail.trim()) log([tail]);
					resolve({ code: code ?? -1, out });
				});
			});
		}
		const dock = (args, o) => exec(docker(), args, o);
		const must = async (args, o) => {
			const r = await dock(args, o);
			if (r.code !== 0) throw new Error(L.dockerError(r.error?.code === "ENOENT" ? "" : r.out, r.error?.code || r.code));
			return r;
		};
		const bpDir = path.join(base, "buildpack", L.BUILDPACK.tag);

		return {
			async check() {
				const r = await dock(L.versionArgs(), { timeout: 15000 });
				if (r.code !== 0) throw new Error(L.dockerError(r.error?.code === "ENOENT" ? "" : r.out, r.error?.code || r.code));
			},
			// Removes mxbuild containers a cancelled build left behind.
			async cleanupBuild() {
				const r = await dock(L.listAllContainersArgs(), { timeout: 10000 });
				const ids = r.code === 0 ? L.leftoverBuildContainers(r.out) : [];
				if (ids.length) await dock(["rm", "-f", ...ids], { timeout: 30000 });
			},
			async hasImage(n) {
				return (await dock(L.imageInspectArgs(n.image), { timeout: 8000 })).code === 0;
			},
			async ensureBuildpack() {
				const marker = path.join(bpDir, ".pi-crust-ok");
				if (fs.existsSync(marker)) return bpDir;
				fs.rmSync(bpDir, { recursive: true, force: true });
				fs.mkdirSync(path.dirname(bpDir), { recursive: true });
				log([`Fetching docker-mendix-buildpack ${L.BUILDPACK.tag}…`]);
				const r = await exec("git", L.buildpackCloneArgs(bpDir), { stream: true, env: { GIT_TERMINAL_PROMPT: "0" } });
				if (r.error?.code === "ENOENT") throw new Error("git not found. Install git (needed to download the Mendix buildpack) and try again.");
				if (r.code !== 0) throw new Error(`Couldn't download the Mendix buildpack (git clone failed):\n${L.buildError(r.out)}`);
				fs.writeFileSync(marker, new Date().toISOString());
				return bpDir;
			},
			async findPython() {
				for (const c of L.pythonCandidates(process.platform)) {
					const r = await exec(c[0], [...c.slice(1), "--version"], { timeout: 10000 });
					const m = r.code === 0 && /Python (\d+)\.(\d+)/.exec(r.out);
					if (m && (+m[1] > 3 || (+m[1] === 3 && +m[2] >= 8))) return c;
				}
				throw new Error("Python 3.8 or later is needed to build with the Mendix buildpack (install from python.org).");
			},
			async build(project, version, signal, n) {
				try {
					await this.buildInner(project, version, signal, n);
				} finally {
					if (signal.aborted) await this.cleanupBuild().catch(() => {});
				}
			},
			async buildInner(project, version, signal, n) {
				const platformMsg = L.platformError(process.platform);
				if (platformMsg) throw new Error(platformMsg);
				const emulation = L.needsEmulation(version, process.arch);
				const benv = L.buildEnv(emulation);
				if (emulation) log(["Mendix " + version + " needs amd64 emulation on this Mac (slow). Docker Desktop: turn on Rosetta for x86_64/amd64 emulation."]);
				const python = await this.findPython();
				const bp = await this.ensureBuildpack();
				if (signal.aborted) throw new Cancelled();
				for (const which of ["builder", "app"]) {
					const tag = L.rootfsTag(which, emulation);
					if ((await dock(L.imageInspectArgs(tag), { env: benv })).code === 0) continue;
					log([`Building the ${which} base image (once)…`]);
					const r = await dock(L.rootfsBuildArgs(bp, which, emulation), { cwd: bp, env: benv, stream: true, signal });
					if (signal.aborted) throw new Cancelled();
					if (r.code !== 0) throw new Error(L.buildError(r.out));
				}
				const dest = path.join(base, n.key, "build");
				fs.rmSync(dest, { recursive: true, force: true });
				fs.mkdirSync(path.dirname(dest), { recursive: true });
				const source = project.kind === "mpk" ? project.file : path.dirname(project.file);
				const a = L.buildMdaArgs({ python, bpDir: bp, source, dest });
				log(["Compiling the Mendix project…"]);
				let r = await exec(a[0], a.slice(1), { cwd: bp, env: benv, stream: true, signal });
				if (signal.aborted) throw new Cancelled();
				if (r.code !== 0) throw new Error(r.error?.code === "ENOENT" ? "Python 3 is needed to build with the Mendix buildpack (install from python.org)." : L.buildError(r.out));
				log(["Building the app image…"]);
				r = await dock(L.imageBuildArgs({ dest, image: n.image, emulation }), { cwd: dest, env: benv, stream: true, signal });
				if (signal.aborted) throw new Cancelled();
				if (r.code !== 0) throw new Error(L.buildError(r.out));
			},
			async ensureDb(n, { dbPassword, image }) {
				const net = await dock(L.networkCreateArgs(n));
				if (net.code !== 0 && !/already exists/i.test(net.out)) throw new Error(L.dockerError(net.out, net.code));
				await must(L.volumeCreateArgs(n));
				const exists = (await dock(L.inspectRunningArgs(n.db))).code === 0;
				this.dbExisted = exists;
				if (exists) await must(L.startArgs(n.db));
				else await must(L.dbRunArgs(n, image), { env: { POSTGRES_PASSWORD: dbPassword } });
				for (let i = 0; i < 60; i++) {
					if ((await dock(L.dbReadyArgs(n))).code === 0) return;
					await sleep(1000);
				}
				throw new Error("Postgres didn't become ready in 60 s. If its data volume came from another Postgres version, use “Reset database” (⋯ menu).");
			},
			dbExisted: false,
			async runApp(n, port, env, emulation) {
				await dock(L.rmArgs(n.app));
				await must(L.appRunArgs(n, port, Object.keys(env)), { env: { ...env, ...L.buildEnv(emulation) } });
			},
			followLogs(n, onLine) {
				const child = spawn(docker(), L.logsArgs(n.app, new Date().toISOString()), { env: envFor(), detached: !IS_WIN, windowsHide: true });
				let tail = "";
				const feed = (d) => {
					const lines = (tail + d.toString()).split(/\r?\n/);
					tail = lines.pop();
					lines.filter((l) => l.trim()).forEach(onLine);
				};
				child.stdout.on("data", feed);
				child.stderr.on("data", feed);
				child.on("error", () => {});
				return () => {
					try {
						killTree(child);
					} catch {}
				};
			},
			async isRunning(name) {
				const r = await dock(L.inspectRunningArgs(name), { timeout: 8000 });
				return r.code === 0 && r.out.trim() === "true";
			},
			async stopApp(n) {
				await dock(L.stopArgs(n.app));
				await dock(L.rmArgs(n.app));
			},
			async resetDb(n) {
				const [rm, vol] = L.resetDbArgs(n);
				await dock(rm);
				const r = await dock(vol);
				if (r.code !== 0 && !/no such volume/i.test(r.out)) throw new Error(L.dockerError(r.out, r.code));
			},
			dockerPath: docker,
		};
	}

	// ---- fake runner for the self-test: the same state machine runs against it, no docker needed ----
	function createFakeRunner({ log, opts }) {
		let server = null;
		return {
			async check() {},
			async hasImage() {
				return false;
			},
			async build() {
				for (let i = 1; i <= 5; i++) {
					log([`[fake build] step ${i}/5`]);
					await sleep(300);
				}
				if (opts.failBuild) throw new Error("Fake build failed: boom");
			},
			async ensureDb() {},
			dbExisted: false,
			async runApp(_n, port, env) {
				await new Promise((resolve, reject) => {
					server = http.createServer((_req, res) => setTimeout(() => res.end("<title>Mendix stub</title><h1>Mendix stub app</h1>"), 1000));
					server.once("error", reject);
					server.listen(port, "127.0.0.1", resolve);
				});
				log([`[fake app] listening on ${port} (admin ${env.ADMIN_PASSWORD.length} chars)`, "Mendix Runtime successfully started"]);
			},
			followLogs: () => () => {},
			async isRunning() {
				return !!server?.listening;
			},
			async stopApp() {
				await new Promise((r) => (server ? server.close(r) : r()));
				server?.closeAllConnections?.();
				server = null;
			},
			async resetDb() {
				log(["[fake] database reset"]);
			},
			dockerPath: () => "docker",
		};
	}

	// ---- state ----
	let runner = null; // created on first use
	let fake = null; // { opts, key, project, version } while the self-test fake is installed
	let cur = { key: "", names: null, projects: [], repoReal: "" };
	let st = fresh();
	let busy = null; // promise of the running start()
	let abort = null;
	let stopFollow = null;
	let monitor = null;
	let runtimeStarted = false;
	let logs = [];

	let detectPending = false; // a detect() was asked while busy
	let entryCache = null; // { key, e }: this repo's saved entry, so log lines don't re-read the settings file
	let lastBuildStatus = 0;

	function fresh() {
		return { state: "none", project: null, version: "", port: 0, url: "", message: "", step: "", since: 0, built: false, adopted: false };
	}
	const getRunner = () => (runner ||= createDockerRunner({ log }));
	const readMendix = () => ctx.readSettings().mendix || {};
	function entry() {
		if (!entryCache || entryCache.key !== cur.key) entryCache = { key: cur.key, e: readMendix()[cur.key] || {} };
		return entryCache.e;
	}
	function saved() {
		let e = entry();
		if (!e.adminPassword || !e.dbPassword) {
			e = { ...e, adminPassword: e.adminPassword || L.genPassword(), dbPassword: e.dbPassword || L.genPassword() };
			saveEntry(e);
		}
		return e;
	}
	function saveEntry(e) {
		entryCache = { key: cur.key, e };
		ctx.writeSettings({ mendix: { ...readMendix(), [cur.key]: e } });
	}
	function dropEntry(key) {
		entryCache = null;
		const m = { ...readMendix() };
		delete m[key];
		ctx.writeSettings({ mendix: m });
	}
	const secrets = () => {
		const e = entry();
		return [e.adminPassword, e.dbPassword];
	};
	function publicStatus() {
		const e = cur.key && st.state !== "none" ? entry() : {};
		return {
			...st,
			project: st.project && { kind: st.project.kind, rel: st.project.rel },
			adminUser: L.ADMIN_USER,
			adminPassword: e.adminPassword || "",
			names: cur.names,
			buildpack: L.BUILDPACK.tag,
		};
	}
	function set(patch) {
		if (patch.message) patch = { ...patch, message: L.redact(patch.message, secrets()) };
		Object.assign(st, patch);
		lastBuildStatus = Date.now();
		ctx.send("mendix:status", publicStatus());
	}
	function log(lines) {
		const sec = secrets();
		const clean = lines.map((l) => L.redact(l, sec));
		L.ringPush(logs, clean);
		if (clean.some(L.isRuntimeStarted)) runtimeStarted = true;
		if (st.state === "building" && clean.length) st.step = clean.at(-1).slice(0, 200);
		ctx.send("mendix:log", { lines: clean });
		// Progress updates while building: at most one per 500 ms, so the UI isn't flooded (state changes go through set()).
		if (st.state === "building" && Date.now() - lastBuildStatus >= 500) {
			lastBuildStatus = Date.now();
			ctx.send("mendix:status", publicStatus());
		}
	}

	function readVersion(project) {
		if (fake) return fake.version;
		if (project.kind !== "mpr") return "";
		try {
			const { DatabaseSync } = require("node:sqlite");
			const db = new DatabaseSync(project.file, { readOnly: true });
			try {
				const v = db.prepare("SELECT _ProductVersion AS v FROM _MetaData LIMIT 1").get()?.v;
				if (v) return String(v);
			} finally {
				db.close();
			}
		} catch {}
		try {
			const fd = fs.openSync(project.file, "r");
			try {
				const buf = Buffer.alloc(2 * 1024 * 1024);
				const n = fs.readSync(fd, buf, 0, buf.length, 0);
				return L.versionFromBytes(buf.subarray(0, n));
			} finally {
				fs.closeSync(fd);
			}
		} catch {
			return "";
		}
	}

	function clearMonitor() {
		clearInterval(monitor);
		monitor = null;
	}
	function watchRunning() {
		clearMonitor();
		monitor = setInterval(async () => {
			if (st.state !== "running" || busy) return;
			if (!(await getRunner().isRunning(cur.names.app).catch(() => true)) && st.state === "running") {
				stopFollow?.();
				stopFollow = null;
				set({ state: "stopped", message: "The app container stopped.", url: "" });
				clearMonitor();
			}
		}, 10000);
		monitor.unref?.();
	}

	function mkProject(p) {
		return p && { ...p, file: path.join(p.dir, p.rel.split("/").pop()) };
	}

	// ---- detect: which Mendix project is in the repo, and is its app already running? ----
	async function detect() {
		if (busy) {
			detectPending = true;
			return publicStatus();
		}
		let key, names, projects, repoReal;
		if (fake) {
			({ key } = fake);
			names = L.names(key);
			projects = [fake.project];
			repoReal = "(selftest)";
		} else {
			if (!ctx.repo) return set({ ...fresh() }), publicStatus();
			try {
				repoReal = fs.realpathSync(ctx.repo);
			} catch {
				repoReal = ctx.repo;
			}
			key = L.keyFor(repoReal);
			names = L.names(key);
			projects = L.findProjects(repoReal);
		}
		const changed = key !== cur.key || (projects[0]?.rel || "") !== (st.project?.rel || "");
		if (!changed) return publicStatus();
		stopFollow?.();
		stopFollow = null;
		clearMonitor();
		logs = [];
		cur = { key, names, projects, repoReal };
		if (!projects.length) {
			st = fresh();
			set({});
			return publicStatus();
		}
		st = { ...fresh(), state: "idle", project: fake ? projects[0] : mkProject(projects[0]) };
		set({});
		const r = getRunner();
		try {
			const saved0 = readMendix()[key] || {};
			if (saved0.port && (await r.isRunning(names.app))) {
				stopFollow = r.followLogs(names, (l) => log([l]));
				set({ state: "running", port: saved0.port, url: `http://localhost:${saved0.port}`, built: true, adopted: true });
				watchRunning();
			} else if (!fake) {
				set({ built: await r.hasImage(names) });
			}
		} catch {}
		saved();
		set({});
		return publicStatus();
	}

	// ---- start ----
	function start({ rebuild }) {
		if (busy) return { busy: true };
		if (!cur.key || !st.project) return { error: "No Mendix project" };
		const platformMsg = fake ? "" : L.platformError(process.platform);
		if (platformMsg) {
			set({ state: "error", message: platformMsg, step: "", url: "" });
			return { error: platformMsg };
		}
		abort = new AbortController();
		const signal = abort.signal;
		const run = (async () => {
			const n = cur.names;
			const r = getRunner();
			const project = st.project;
			logs.length = 0;
			ctx.send("mendix:log", { reset: true, lines: [] });
			stopFollow?.();
			stopFollow = null;
			clearMonitor();
			let appStarted = false;
			let dbExisted = false;
			const guard = () => {
				if (signal.aborted) throw new Cancelled();
			};
			try {
				set({ state: "checking", message: "", step: "Checking Docker…", since: Date.now(), url: "", adopted: false });
				await r.check();
				guard();
				const version = readVersion(project);
				set({ version });
				const sup = L.checkSupport(version);
				if (!sup.ok) throw new Error(sup.message);
				if (rebuild || !(await r.hasImage(n))) {
					set({ state: "building", step: "Preparing the build…", since: Date.now() });
					await r.build(project, version, signal, n);
					guard();
					set({ built: true });
				}
				set({ state: "starting", step: "Starting Postgres…", since: Date.now() });
				runtimeStarted = false;
				const e = saved();
				await r.ensureDb(n, { dbPassword: e.dbPassword, image: ctx.readSettings().mendixPostgresImage });
				guard();
				dbExisted = !!r.dbExisted;
				const port = await L.pickPort(e.port || 8080);
				saveEntry({ ...e, port });
				set({ port, step: "Starting the app…" });
				const env = L.appEnv({ adminPassword: e.adminPassword, dbPassword: e.dbPassword, port });
				appStarted = true;
				await r.runApp(n, port, env, L.needsEmulation(version, process.arch));
				guard();
				stopFollow = r.followLogs(n, (l) => log([l]));
				// wait until it answers
				const timeoutMs = (Number(ctx.readSettings().mendixStartTimeoutSec) || 300) * 1000;
				const t0 = Date.now();
				let lastCheck = 0;
				for (;;) {
					guard();
					if (Date.now() - t0 > timeoutMs) throw new Error(`The app didn't answer within ${Math.round(timeoutMs / 1000)} s. See the logs.`);
					let up = runtimeStarted;
					if (!up) {
						try {
							const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000), redirect: "manual" });
							up = res.status < 500;
						} catch {}
					}
					if (up) break;
					if (Date.now() - lastCheck > 5000) {
						lastCheck = Date.now();
						if (!(await r.isRunning(n.app))) throw new Error(`The app container stopped.\n${logs.slice(-6).join("\n")}`);
					}
					await sleep(2000);
				}
				set({ state: "running", url: `http://localhost:${port}`, message: "", step: "" });
				watchRunning();
			} catch (err) {
				if (err instanceof Cancelled || signal.aborted) return;
				stopLogFollow();
				if (appStarted) await r.stopApp(n).catch(() => {});
				let msg = L.redact(String(err.message || err), secrets());
				if (appStarted && dbExisted) msg += "\nIf the database was created with another password, use “Reset database” (⋯ menu).";
				log([`Error: ${msg.split("\n")[0]}`]);
				set({ state: "error", message: msg, step: "", url: "" });
			}
		})();
		busy = run.finally(() => {
			busy = null;
			abort = null;
			if (detectPending) {
				detectPending = false;
				detect().catch(() => {});
			}
		});
		return { started: true };
	}
	// Stops following the app's logs (`docker logs -f`).
	function stopLogFollow() {
		stopFollow?.();
		stopFollow = null;
	}

	async function stop() {
		if (!cur.key || !st.project) return { ok: true };
		const wasBusy = busy;
		if (wasBusy) {
			abort.abort();
			set({ state: "stopping", step: "Stopping…" });
			await wasBusy.catch(() => {});
		} else if (st.state === "idle" || st.state === "stopped") {
			if (fake) dropEntry(cur.key);
			return { ok: true };
		}
		else set({ state: "stopping", step: "Stopping…" });
		clearMonitor();
		stopFollow?.();
		stopFollow = null;
		try {
			await getRunner().stopApp(cur.names);
		} catch {}
		if (fake) dropEntry(cur.key);
		set({ state: "stopped", message: "", step: "", url: "" });
		return { ok: true };
	}

	async function resetDb() {
		if (busy) return { busy: true };
		const wasRunning = st.state === "running";
		await stop();
		try {
			await getRunner().resetDb(cur.names);
		} catch (e) {
			const msg = L.redact(String(e.message || e), secrets());
			set({ state: "error", message: msg });
			return { error: msg };
		}
		const e = { ...(readMendix()[cur.key] || {}) };
		delete e.dbPassword;
		saveEntry(e);
		saved();
		set({ state: "stopped" });
		if (wasRunning) start({ rebuild: false });
		return { ok: true };
	}

	// ---- quit: stop the app containers, leave Postgres running ----
	app.on("before-quit", () => {
		try {
			abort?.abort();
		} catch {}
		clearMonitor();
		try {
			stopFollow?.();
		} catch {}
		if (ctx.readSettings().mendixStopOnQuit === false) return;
		if (fake || !runner) return;
		try {
			const bin = runner.dockerPath();
			const ids = execFileSync(bin, L.stopAllAppsArgs(), { env: ctx.env, timeout: 3000, windowsHide: true, encoding: "utf8" }).split(/\s+/).filter(Boolean);
			if (ids.length) spawn(bin, ["stop", "-t", "10", ...ids], { env: ctx.env, detached: true, stdio: "ignore", windowsHide: true }).unref();
		} catch {}
	});

	// ---- IPC ----
	ipcMain.handle("mendix:detect", () => detect());
	ipcMain.handle("mendix:start", () => start({ rebuild: false }));
	ipcMain.handle("mendix:rebuild", () => start({ rebuild: true }));
	ipcMain.handle("mendix:stop", () => stop());
	ipcMain.handle("mendix:resetDb", () => resetDb());
	ipcMain.handle("mendix:logs", () => logs.slice());
	ipcMain.handle("mendix:copyPassword", (_e) => {
		const pw = (readMendix()[cur.key] || {}).adminPassword;
		if (!pw) return { ok: false };
		require("electron").clipboard.writeText(pw);
		return { ok: true };
	});
	if (ctx.selftest) {
		ipcMain.handle("mendix:selftestFake", async (_e, opts = {}) => {
			if (busy) {
				abort?.abort();
				await busy.catch(() => {});
			}
			stopFollow?.();
			stopFollow = null;
			clearMonitor();
			await runner?.stopApp?.(cur.names);
			if (fake) dropEntry(fake.key);
			const key = "pcm-selftest-00000000";
			dropEntry(key);
			fake = { opts, key, version: opts.version || "10.18.0.12345", project: { kind: "mpr", rel: "FakeApp/FakeApp.mpr", dir: "/fake/FakeApp", file: "/fake/FakeApp/FakeApp.mpr" } };
			runner = createFakeRunner({ log, opts });
			cur = { key: "", names: null, projects: [], repoReal: "" };
			st = fresh();
			return detect();
		});
	}
}

module.exports = { register };
