// Changes to one entry of the open-chats list: its session file and its pending record (a Claude Agent chat that is a fork or was rewound and has
// no session of its own yet). Every change that touches both is ONE call and ONE save: a crash between two saves (the pending record cleared,
// the new session file not yet written) would restore a rewound chat as it was before the rewind.
"use strict";

// deps: { find: (chatId) => entry | undefined, save: () => void, cleanPending: (p) => p | null }
function createEntryWriter({ find, save, cleanPending }) {
	function setChatEntry(chatId, { file, pending } = {}) {
		const e = find(chatId);
		if (!e) return false;
		let changed = false;
		if (typeof file === "string" && file && e.file !== file) {
			e.file = file;
			changed = true;
		}
		if (pending !== undefined) {
			const next = pending ? cleanPending(pending) : null;
			if (JSON.stringify(next) !== JSON.stringify(e.pending || null)) {
				e.pending = next;
				changed = true;
			}
		}
		if (changed) save();
		return changed;
	}
	const setChatFile = (chatId, file) => void setChatEntry(chatId, { file });
	const setChatPending = (chatId, pending) => void setChatEntry(chatId, { pending });
	// The adapter reports "no longer pending" and then the new session id, one right after the other. The first is held back for the second, so
	// the list changes once (the new session AND no pending record). Alone (no session follows in the same turn of the event loop) it is saved as it is.
	const held = new Set();
	function chatPendingRecord(chatId, pending) {
		if (pending) {
			held.delete(chatId);
			return setChatPending(chatId, pending);
		}
		held.add(chatId);
		queueMicrotask(() => {
			if (held.delete(chatId)) setChatPending(chatId, null);
		});
	}
	function chatSessionRecord(chatId, sessionId) {
		if (held.delete(chatId)) return void setChatEntry(chatId, { file: sessionId, pending: null });
		setChatFile(chatId, sessionId);
	}
	return { setChatEntry, setChatFile, setChatPending, chatPendingRecord, chatSessionRecord };
}

module.exports = { createEntryWriter };
