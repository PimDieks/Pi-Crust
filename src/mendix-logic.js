// Run a Mendix app from the open repo: pure helpers (no Electron). The runner is in mendix-main.js.
// Builds with a pinned mendix/docker-mendix-buildpack and runs the app next to a Postgres container.
//
// Checked against docker-mendix-buildpack v6.0.8 (README, build.py, Dockerfile, rootfs-*.dockerfile):
// - Needs Docker 20.10+, Python 3.8+ on the host (on Windows the README supports only Python inside WSL),
//   and a Mendix 8+ app. "ARM64 CPUs are not fully supported".
// - build.py has ONE action, `build-mda-dir`, with --source (a folder with exactly one .mpr, or an .mpk) and
//   --destination. It has no --tag, --use-emulation or build-image. It must run with the buildpack folder as cwd
//   (it copies ./scripts and ./Dockerfile). The image is then built with `docker build <destination>`.
// - The Dockerfile needs prebuilt rootfs images: `docker build -t <t> -f rootfs-app.dockerfile .` and
//   rootfs-builder.dockerfile, passed as build args ROOTFS_IMAGE and BUILDER_ROOTFS_IMAGE.
// - arm64: build.py downloads arm64 mxbuild only for dotnet (Mendix >= 9.22); older versions use mono, which only
//   exists for amd64, so those need Docker's amd64 emulation: DOCKER_DEFAULT_PLATFORM=linux/amd64 for every step.
// - Runtime: ADMIN_PASSWORD (admin user MxAdmin), DATABASE_ENDPOINT=postgres://user:pw@host:port/db,
//   DEVELOPMENT_MODE, MXRUNTIME_<Setting>; the app (nginx) listens on 8080 (ENV PORT 8080).
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

const BUILDPACK = {
	repo: "https://github.com/mendix/docker-mendix-buildpack.git",
	tag: "v6.0.8",
	minMendix: "8.0.0.0",
	maxMajor: null, // the README names no upper bound
	dotnetFrom: "9.22.0.0", // below this mxbuild runs on mono (amd64 only)
	appPort: 8080,
};
const LABEL = "dev.picrust.mendix";
const ADMIN_USER = "MxAdmin";
const DEFAULT_POSTGRES = "postgres:14-alpine";
const SKIP_DIRS = new Set(["node_modules", "deployment", ".git", ".mendix-cache", "theme-cache", "releases", "dist"]);

const defaultReaddir = (dir) => fs.readdirSync(dir, { withFileTypes: true });

// Mendix projects in `root`, up to `maxDepth` folders deep: [{ kind, rel, dir }]; shallowest first, .mpr before .mpk.
function findProjects(root, { readdir = defaultReaddir, maxDepth = 2 } = {}) {
	const found = [];
	const walk = (dir, rel, depth) => {
		let entries;
		try {
			entries = readdir(dir);
		} catch {
			return;
		}
		for (const e of entries) {
			const isDir = e.isDirectory();
			if (!isDir && /\.(mpr|mpk)$/i.test(e.name)) found.push({ kind: e.name.toLowerCase().endsWith(".mpr") ? "mpr" : "mpk", rel: rel ? `${rel}/${e.name}` : e.name, dir: rel ? `${root}/${rel}` : root, depth });
		}
		if (depth >= maxDepth) return;
		for (const e of entries) if (e.isDirectory() && !SKIP_DIRS.has(e.name)) walk(`${dir}/${e.name}`, rel ? `${rel}/${e.name}` : e.name, depth + 1);
	};
	walk(root, "", 0);
	const order = (p) => p.depth * 2 + (p.kind === "mpr" ? 0 : 1);
	return found.sort((a, b) => order(a) - order(b) || a.rel.localeCompare(b.rel)).map(({ depth, ...p }) => p);
}

// Fallback for the Mendix version: look in the raw bytes of an .mpr (SQLite) for something like 10.18.1.12345.
function versionFromBytes(buf) {
	const text = Buffer.from(buf).subarray(0, 2 * 1024 * 1024).toString("latin1");
	const m = text.match(/\b(\d{1,2}\.\d{1,2}\.\d{1,3}\.\d{3,6})\b/);
	return m ? m[1] : "";
}

const parts = (v) => String(v || "").split(".").map((n) => parseInt(n, 10) || 0);
function compareVersions(a, b) {
	const x = parts(a);
	const y = parts(b);
	for (let i = 0; i < Math.max(x.length, y.length); i++) {
		const d = (x[i] || 0) - (y[i] || 0);
		if (d) return d < 0 ? -1 : 1;
	}
	return 0;
}

function checkSupport(version, { min = BUILDPACK.minMendix, maxMajor = BUILDPACK.maxMajor } = {}) {
	if (!version) return { ok: true, message: "" };
	const short = version.split(".").slice(0, 2).join(".");
	if (compareVersions(version, min) < 0)
		return { ok: false, message: `Mendix ${short} isn't supported by docker-mendix-buildpack ${BUILDPACK.tag} (needs ≥ ${min.replace(/(\.0)+$/, "")}). Upgrade the project in Studio Pro and try again.` };
	if (maxMajor != null && parts(version)[0] > maxMajor) return { ok: false, message: `Mendix ${short} is newer than docker-mendix-buildpack ${BUILDPACK.tag} supports (up to ${maxMajor}).` };
	return { ok: true, message: "" };
}

// arm64 + mono mxbuild (Mendix < 9.22) only exists for amd64: run the build under Docker's emulation.
function needsEmulation(version, arch) {
	return arch === "arm64" && !!version && compareVersions(version, BUILDPACK.dotnetFrom) < 0;
}

function keyFor(repoReal) {
	const base = String(repoReal).split(/[\\/]+/).filter(Boolean).pop() || "repo";
	const slug = base.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 20).replace(/-+$/g, "") || "repo";
	return `pcm-${slug}-${crypto.createHash("sha1").update(String(repoReal)).digest("hex").slice(0, 8)}`;
}

function names(key) {
	return { key, net: `${key}-net`, volume: `${key}-pgdata`, db: `${key}-db`, app: `${key}-app`, image: `${key}-app:latest`, label: LABEL };
}

const UP = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const LOW = "abcdefghijkmnopqrstuvwxyz";
const DIG = "23456789";
const SYM = "-_.";
function genPassword(len = 20, rand = crypto.randomBytes) {
	const all = UP + LOW + DIG + SYM;
	const pick = (set) => set[rand(1)[0] % set.length];
	const out = [pick(UP), pick(LOW), pick(DIG), pick(SYM)];
	while (out.length < len) out.push(pick(all));
	// shuffle (Fisher–Yates) so the required characters aren't always first
	for (let i = out.length - 1; i > 0; i--) {
		const j = rand(1)[0] % (i + 1);
		[out[i], out[j]] = [out[j], out[i]];
	}
	return out.join("");
}

function isPortFree(port) {
	return new Promise((resolve) => {
		const s = net.createServer();
		s.once("error", () => resolve(false));
		s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
	});
}

async function pickPort(preferred, isFree = isPortFree) {
	const tries = [preferred, ...Array.from({ length: 20 }, (_, i) => 8080 + i)].filter((p, i, a) => p && a.indexOf(p) === i);
	for (const p of tries) if (await isFree(p)) return p;
	return new Promise((resolve, reject) => {
		const s = net.createServer();
		s.once("error", reject);
		s.listen(0, "127.0.0.1", () => {
			const { port } = s.address();
			s.close(() => resolve(port));
		});
	});
}

// Windows isn't supported yet (the buildpack needs Python inside WSL), so there are no candidates there: never run `py -3`.
const pythonCandidates = (platform) => (platform === "win32" ? [] : [["python3"], ["python"]]);
const platformError = (platform) => (platform === "win32" ? "Running Mendix apps isn't supported on Windows yet: the Mendix buildpack needs WSL (Python and Docker inside WSL). Open the repo in WSL, or use macOS or Linux." : "");
const dockerCandidates = (platform) =>
	platform === "darwin" ? ["/usr/local/bin/docker", "/opt/homebrew/bin/docker", "/Applications/Docker.app/Contents/Resources/bin/docker", "docker"] : ["docker"];

// --- argument builders: docker ones return the args after `docker` ---
const buildpackCloneArgs = (dest) => ["clone", "--config", "core.autocrlf=false", "--depth", "1", "--branch", BUILDPACK.tag, BUILDPACK.repo, dest];
const rootfsTag = (which, emulation) => `pi-crust-mendix-rootfs:${which}-${BUILDPACK.tag}${emulation ? "-amd64" : ""}`;
const rootfsBuildArgs = (bpDir, which, emulation = false) => ["build", "-t", rootfsTag(which, emulation), "-f", path.join(bpDir, `rootfs-${which}.dockerfile`), bpDir];
// build.py (cwd = bpDir): turns the project into an extracted MDA plus Dockerfile in `dest`.
const buildMdaArgs = ({ python, bpDir, source, dest }) => [...python, path.join(bpDir, "build.py"), "--source", source, "--destination", dest, "build-mda-dir"];
const imageBuildArgs = ({ dest, image, emulation = false }) => [
	"build", "--tag", image,
	"--build-arg", `ROOTFS_IMAGE=${rootfsTag("app", emulation)}`,
	"--build-arg", `BUILDER_ROOTFS_IMAGE=${rootfsTag("builder", emulation)}`,
	dest,
];
const buildEnv = (emulation) => (emulation ? { DOCKER_DEFAULT_PLATFORM: "linux/amd64" } : {});
const networkCreateArgs = (n) => ["network", "create", "--label", `${LABEL}=${n.key}`, n.net];
const volumeCreateArgs = (n) => ["volume", "create", "--label", `${LABEL}=${n.key}`, n.volume];
const dbRunArgs = (n, image = DEFAULT_POSTGRES) => [
	"run", "-d", "--name", n.db, "--network", n.net, "--network-alias", "db",
	"-v", `${n.volume}:/var/lib/postgresql/data`,
	"-e", "POSTGRES_USER=mendix", "-e", "POSTGRES_DB=mendix", "-e", "POSTGRES_PASSWORD", // value comes from the env
	"--label", `${LABEL}=${n.key}`, "--label", `${LABEL}.role=db`,
	image || DEFAULT_POSTGRES,
];
const dbReadyArgs = (n) => ["exec", n.db, "pg_isready", "-U", "mendix", "-d", "mendix"];
// Env for the docker CLI child: the values never reach the command line.
const appEnv = ({ adminPassword, dbPassword, port }) => ({
	ADMIN_PASSWORD: adminPassword,
	DATABASE_ENDPOINT: `postgres://mendix:${dbPassword}@db:5432/mendix`,
	DEVELOPMENT_MODE: "true",
	MXRUNTIME_ApplicationRootUrl: `http://localhost:${port}`,
});
const appRunArgs = (n, port, envNames) => [
	"run", "-d", "--name", n.app, "--network", n.net, "-p", `127.0.0.1:${port}:${BUILDPACK.appPort}`,
	...envNames.flatMap((k) => ["-e", k]),
	"--label", `${LABEL}=${n.key}`, "--label", `${LABEL}.role=app`,
	n.image,
];
const rmArgs = (name) => ["rm", "-f", name];
const stopArgs = (name) => ["stop", "-t", "20", name];
const startArgs = (name) => ["start", name];
const inspectRunningArgs = (name) => ["inspect", "-f", "{{.State.Running}}", name];
const imageInspectArgs = (image) => ["image", "inspect", image];
const logsArgs = (name, since) => ["logs", "-f", ...(since ? ["--since", since] : []), name];
const resetDbArgs = (n) => [rmArgs(n.db), ["volume", "rm", n.volume]];
const stopAllAppsArgs = () => ["ps", "-q", "--filter", `label=${LABEL}.role=app`];
// Containers left behind by a cancelled build.py (mxbuild runs in `mendix-buildpack:mxbuild-<version>` containers).
const listAllContainersArgs = () => ["ps", "-a", "--format", "{{.ID}} {{.Image}}"];
const leftoverBuildContainers = (out) =>
	String(out || "").split(/\r?\n/).map((l) => l.trim().split(/\s+/)).filter(([id, image]) => id && /^(?:[^/\s]+\/)*mendix-buildpack:mxbuild-/.test(image || "")).map(([id]) => id);
const versionArgs = () => ["version", "--format", "{{.Server.Version}}"];

const lastLines = (text, n) => String(text || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-n);

function dockerError(stderr, code) {
	if (code === "ENOENT") return `Docker isn't installed (looked for docker in ${dockerCandidates(process.platform).join(", ")}). Install Docker Desktop and try again.`;
	if (/Cannot connect to the Docker daemon|error during connect|pipe.*docker_engine|Is the docker daemon running/i.test(String(stderr))) return "Docker isn't running. Start Docker Desktop and try again.";
	return lastLines(stderr, 3).join("\n") || `docker failed (${code})`;
}

function buildError(output) {
	const o = String(output || "");
	if (/No supported files found|More than one \.mpr|More than one \.mpk/i.test(o)) return "The buildpack found no single Mendix project (.mpr) to build in that folder.";
	if (/Python.*(not found|No such file)|ENOENT.*python/i.test(o)) return "Python 3 is needed to build with the Mendix buildpack (install from python.org).";
	if (/mxbuild-[\d.]+\.tar\.gz.*(404|Not Found)|\b404\b.*mxbuild|returned a non-zero code: 8/i.test(o)) return "Mendix's build tools for this version couldn't be downloaded (mxbuild not found). Check that the version exists and your network works.";
	if (/exec format error|no matching manifest for linux\/arm64|rosetta|qemu/i.test(o)) return "This build needs amd64 emulation. In Docker Desktop turn on “Use Rosetta for x86_64/amd64 emulation” and try again.";
	if (/Cannot connect to the Docker daemon|error during connect/i.test(o)) return "Docker isn't running. Start Docker Desktop and try again.";
	return lastLines(o, 6).join("\n") || "The build failed.";
}

const isRuntimeStarted = (line) => /Mendix Runtime successfully started|Runtime successfully started/.test(String(line));

function ringPush(buf, lines, max = 2000) {
	buf.push(...lines);
	if (buf.length > max) buf.splice(0, buf.length - max);
	return buf;
}

function redact(text, secrets) {
	let out = String(text);
	for (const s of secrets || []) if (s && String(s).length >= 4) out = out.split(String(s)).join("••••");
	return out;
}

module.exports = {
	BUILDPACK, LABEL, ADMIN_USER, DEFAULT_POSTGRES,
	findProjects, versionFromBytes, compareVersions, checkSupport, needsEmulation, keyFor, names, genPassword, pickPort, isPortFree,
	pythonCandidates, platformError, dockerCandidates, listAllContainersArgs, leftoverBuildContainers,
	buildpackCloneArgs, rootfsTag, rootfsBuildArgs, buildMdaArgs, imageBuildArgs, buildEnv, networkCreateArgs, volumeCreateArgs,
	dbRunArgs, dbReadyArgs, appEnv, appRunArgs, rmArgs, stopArgs, startArgs, inspectRunningArgs, imageInspectArgs, logsArgs, resetDbArgs, stopAllAppsArgs, versionArgs,
	dockerError, buildError, isRuntimeStarted, ringPush, redact,
};
