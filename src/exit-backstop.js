// The process "exit" backstop: when the app dies (a crash, process.exit) no chat's agent may be left running. Runs inside an exit
// handler, so everything here is synchronous. Goes through the chat's adapter (c.agent) and handle (c.handle), never a raw process.
"use strict";

// chats: an iterable of { agent, handle }. Never throws; returns how many kills were attempted.
function killAllSync(chats) {
	let n = 0;
	for (const c of chats) {
		try {
			const st = c.agent.state(c.handle);
			if (st.exitCode !== null) continue;
			n++;
			c.agent.killRemains(c.handle, { sync: true }); // Windows: only /F ends a windowless console process
		} catch {}
	}
	return n;
}

module.exports = { killAllSync };
