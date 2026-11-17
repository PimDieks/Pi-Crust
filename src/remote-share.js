// Which chats the phone may see. Chat ids are reassigned on every app start, so sharing is also remembered by session
// file: a chat is shared if its id was shared in this run or its current session file was shared earlier.
"use strict";

const MAX_FILES = 200;

function createShareSet({ load = () => [], save = () => {} } = {}) {
	const ids = new Set();
	const fileOf = new Map(); // chatId -> the file we stored for it, so forget(chatId) can drop it without being told
	// Insertion order = age: re-adding moves a file to the newest end, the cap drops from the oldest end.
	const files = new Set((load() || []).filter((f) => typeof f === "string" && f).slice(-MAX_FILES));
	const persist = () => save([...files]);
	const addFile = (file) => {
		if (typeof file !== "string" || !file) return false;
		const had = files.has(file);
		files.delete(file);
		files.add(file);
		while (files.size > MAX_FILES) files.delete(files.values().next().value);
		return !had;
	};
	return {
		isShared: (chatId, file) => ids.has(chatId) || (!!file && files.has(file)),
		share(chatId, file) {
			ids.add(chatId);
			if (addFile(file) || file) fileOf.set(chatId, file);
			persist();
		},
		unshare(chatId, file) {
			ids.delete(chatId);
			const f = file || fileOf.get(chatId);
			fileOf.delete(chatId);
			if (f) files.delete(f);
			persist();
		},
		// A shared chat got its session file (Pi creates it after the first message): remember it.
		noteFile(chatId, file) {
			if (!ids.has(chatId) || typeof file !== "string" || !file) return;
			const old = fileOf.get(chatId);
			if (old && old !== file) files.delete(old); // the chat moved to another session (/new, resume)
			fileOf.set(chatId, file);
			if (addFile(file) || old !== file) persist();
		},
		// The chat was closed: drop its id and its file, so closing ends the sharing for good.
		forget(chatId, file) {
			const had = ids.delete(chatId);
			const f = file || fileOf.get(chatId);
			fileOf.delete(chatId);
			const hadFile = !!f && files.delete(f);
			if (had || hadFile) persist();
		},
		ids: () => [...ids],
	};
}

module.exports = { createShareSet, MAX_FILES };
