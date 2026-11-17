// Remote access over Tailscale: find the CLI, read its status, publish the local server with `tailscale serve`.
// The parsers are pure; the exec wrappers take an injected `run(bin, args, opts) -> Promise<{ stdout, stderr, code }>`.
"use strict";

function candidates(platform) {
	const list = [];
	if (platform === "win32") list.push("C:\\Program Files\\Tailscale\\tailscale.exe", "tailscale.exe");
	else if (platform === "darwin") list.push("/Applications/Tailscale.app/Contents/MacOS/Tailscale", "/opt/homebrew/bin/tailscale", "/usr/local/bin/tailscale");
	else list.push("/usr/bin/tailscale", "/usr/local/bin/tailscale");
	list.push("tailscale"); // whatever is on PATH
	return [...new Set(list)];
}

const asJson = (x) => {
	if (typeof x !== "string") return x;
	try {
		return JSON.parse(x);
	} catch {
		return null;
	}
};

// `tailscale status --json`
function parseStatus(json) {
	const s = asJson(json) || {};
	const dns = typeof s.Self?.DNSName === "string" ? s.Self.DNSName.replace(/\.$/, "") : "";
	const selfId = s.Self?.UserID;
	const users = s.User && typeof s.User === "object" ? s.User : {};
	const login = selfId != null ? users[String(selfId)]?.LoginName : "";
	const tailnet = s.CurrentTailnet?.Name || s.MagicDNSSuffix;
	// Other people on the tailnet: distinct owners of peers, not counting tagged or shared-in nodes.
	const others = new Set();
	const peers = s.Peer && typeof s.Peer === "object" ? Object.values(s.Peer) : [];
	for (const p of peers) {
		if (!p || typeof p !== "object" || p.UserID == null || p.UserID === selfId) continue;
		if ((Array.isArray(p.Tags) && p.Tags.length) || p.ShareeNode === true) continue;
		others.add(p.UserID);
	}
	return {
		running: s.BackendState === "Running",
		dnsName: dns,
		https: Array.isArray(s.CertDomains) && s.CertDomains.length > 0,
		loginName: typeof login === "string" ? login : "",
		tailnet: typeof tailnet === "string" ? tailnet : "",
		otherUsers: others.size,
	};
}

// `tailscale serve status --json` -> what <host>:<httpsPort> publishes. "No serve config" (not JSON) and {} both mean nothing.
// target: what "/" proxies to. otherHandlers: anything else on that port (other paths, non-proxy handlers, other names).
// tcpOther: a TCP entry for the port that isn't the HTTPS front of our Web mapping. funnel: reachable from the public internet.
function parseServeStatus(json, host, httpsPort) {
	const s = asJson(json) || {};
	const key = `${host}:${httpsPort}`;
	const web = s.Web && typeof s.Web === "object" ? s.Web : {};
	const entry = web[key];
	const handlers = entry?.Handlers && typeof entry.Handlers === "object" ? entry.Handlers : {};
	const target = handlers["/"]?.Proxy;
	const onlyRoot = Object.keys(handlers).every((p) => p === "/");
	const rootIsProxy = !handlers["/"] || typeof handlers["/"].Proxy === "string";
	const otherNames = Object.keys(web).some((k) => k !== key && k.endsWith(`:${httpsPort}`));
	const tcp = s.TCP?.[String(httpsPort)];
	return {
		target: typeof target === "string" ? target : null,
		funnel: s.AllowFunnel?.[key] === true,
		otherHandlers: !onlyRoot || !rootIsProxy || otherNames,
		tcpOther: !!tcp && (!entry || !tcp.HTTPS || !!tcp.TCPForward),
	};
}

// `serve` prints a login.tailscale.com link (and may wait) when Serve or HTTPS isn't enabled for the tailnet.
function extractConsentUrl(output) {
	const m = /https:\/\/login\.tailscale\.com\/[^\s"'<>)]+/.exec(String(output || ""));
	return m ? m[0].replace(/[.,;]+$/, "") : null;
}

// First candidate that answers `status --json` with JSON (a stopped backend still prints it, sometimes with a non-zero exit).
async function detect(run, platform = process.platform) {
	for (const bin of candidates(platform)) {
		try {
			const r = await run(bin, ["status", "--json"], { timeout: 15_000 });
			const out = asJson(r?.stdout);
			if (out && typeof out === "object") return { found: true, bin, ...parseStatus(out) };
		} catch {}
	}
	return { found: false, bin: null, running: false, dnsName: "", https: false, loginName: "", tailnet: "", otherUsers: 0 };
}

async function serveStatus(run, bin, host, httpsPort) {
	try {
		const r = await run(bin, ["serve", "status", "--json"], { timeout: 10_000 });
		return { ok: true, ...parseServeStatus(r?.stdout, host, httpsPort) };
	} catch {
		return { ok: false, target: null, funnel: false, otherHandlers: false, tcpOther: false };
	}
}

async function serveOn(run, bin, httpsPort, port) {
	try {
		const r = await run(bin, ["serve", "--bg", `--https=${httpsPort}`, `http://127.0.0.1:${port}`], { timeout: 20_000 });
		const output = `${r?.stdout || ""}\n${r?.stderr || ""}`.trim();
		const consentUrl = extractConsentUrl(output);
		return { ok: !consentUrl && (r?.code ?? 0) === 0, output, consentUrl };
	} catch (e) {
		const output = `${e?.stdout || ""}\n${e?.stderr || ""}\n${e?.message || ""}`.trim();
		return { ok: false, output, consentUrl: extractConsentUrl(output) };
	}
}

async function serveOff(run, bin, httpsPort) {
	try {
		const r = await run(bin, ["serve", `--https=${httpsPort}`, "off"], { timeout: 20_000 });
		return { ok: (r?.code ?? 0) === 0 };
	} catch {
		return { ok: false };
	}
}

module.exports = { candidates, parseStatus, parseServeStatus, extractConsentUrl, detect, serveStatus, serveOn, serveOff };
