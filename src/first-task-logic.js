// The guided first task, pure logic: which step the user is on, from real events. UMD: `FirstTask` in the UI, `require("./first-task-logic")` in tests.
// Three steps, each ticks only when the thing really happened:
//   1. Ask Pi what this project is       -> done when a turn of the chat ends (agent_end) after an assistant reply with text and no error
//   2. Let it add one line to the README -> done when a later turn of THE chat the task started in ends without error AND README.md itself
//                                           changed meanwhile: it is in the changed paths after the turn and was not before, or it was already
//                                           modified and its stamp (modification time) differs
//   3. Press Rewind to undo it           -> done when a restore in the same chat finishes and the restored paths include README.md
// The task is bound to the chat that was active when it started: events of any other chat never tick it.
// Events (see reduce): start { chatId }, record { chatId, record } (Pi's records), snapshot { chatId, paths, readme, baseline? } (the changed
// paths and README.md's stamp; baseline: taken as the turn begins), restore { chatId, files, paths }, retry, reset.
// The card never sends anything: the prompts only go into the message box (first-task.js).
(function (root, make) {
	const api = make();
	if (typeof module === "object" && module.exports) module.exports = api;
	else root.FirstTask = api;
})(typeof self !== "undefined" ? self : this, function () {
	const STEPS = [
		{
			n: 1,
			title: "Ask Pi about your project",
			hint: "Press Enter to send the text in the message box.",
			prompt: "What is this project? Give me a short summary for a designer.",
			button: "Put the text in the box",
		},
		{
			n: 2,
			title: "Let Pi change one file",
			hint: "Pi adds a line to README.md. Your other changes stay as they are. Open the Changes tab to see it.",
			prompt: "Add one line at the end of README.md that says: Hello from Pi Crust. If there is no README.md, create it.",
			button: "Put the text in the box",
		},
		{
			n: 3,
			title: "Undo it",
			hint: 'Hover your message, click Rewind, choose "Restore the files".',
			prompt: null,
			button: "Show me where",
		},
	];
	const DONE_TEXT = "You've seen the loop: ask, change, undo. Pi Crust remembers this.";
	const RETRY_HINT = "That didn't finish. Try again.";

	const initial = () => ({ phase: "idle", chatId: null, turn: null, before: null, snap: null, failed: false });
	const README = "README.md";
	const isReadme = (p) => String(p || "").replace(/[\\]/g, "/").toLowerCase() === README.toLowerCase();
	// Did README.md itself change between two snapshots? New in the list, or already there and its stamp moved.
	const readmeChanged = (before, after) => {
		if (!before || !after) return false;
		const was = before.paths.some(isReadme);
		const is = after.paths.some(isReadme);
		if (!is) return false;
		return !was || (after.readme != null && after.readme !== before.readme);
	};
	const stepOf = (s) => ({ step1: 1, step2: 2, step3: 3, done: 4 })[s.phase] || 0;

	const hasText = (m) => Array.isArray(m?.content) && m.content.some((c) => c && c.type === "text" && String(c.text || "").trim());
	const failedMessage = (m) => m?.stopReason === "error" || !!m?.errorMessage;

	// Next state for one event. Never mutates its input.
	function reduce(prev, ev) {
		const s = { ...prev, turn: prev.turn ? { ...prev.turn } : null };
		switch (ev.type) {
			case "start":
				return { ...initial(), phase: "step1", chatId: ev.chatId || null };
			case "reset":
				return initial();
			case "retry":
				return { ...s, failed: false };
			case "snapshot": {
				if (s.phase !== "step2" && s.phase !== "step1") return s;
				if (s.chatId && ev.chatId !== s.chatId) return s; // another chat's Changes list says nothing about this task
				const snap = { paths: Array.isArray(ev.paths) ? ev.paths.map(String) : [], readme: ev.readme == null ? null : ev.readme };
				s.snap = snap;
				if (ev.baseline || !s.turn) s.before = snap; // taken as a turn begins, or between turns: this is what "before" means
				return settle2(s);
			}
			case "restore":
				// Only a restore in this chat that put README.md back: restoring some other file is not the undo this step asks for.
				if (s.phase === "step3" && ev.files >= 1 && s.chatId && s.chatId === ev.chatId && Array.isArray(ev.paths) && ev.paths.some(isReadme)) s.phase = "done";
				return s;
			case "record": {
				if (s.phase !== "step1" && s.phase !== "step2") return s;
				if (s.chatId && ev.chatId !== s.chatId) return s; // only the chat the task started in
				const r = ev.record || {};
				if (r.type === "agent_start") {
					s.chatId = s.chatId || ev.chatId;
					s.turn = { open: true, text: false, error: false, ended: false };
					if (s.phase === "step2") s.before = s.snap; // the latest known list; a baseline snapshot taken right now replaces it
					s.failed = false;
				} else if (r.type === "message_end" && s.turn?.open && r.message?.role === "assistant") {
					if (hasText(r.message)) s.turn.text = true;
					if (failedMessage(r.message)) s.turn.error = true;
				} else if (r.type === "agent_end" && s.turn?.open) {
					s.turn.open = false;
					s.turn.ended = true;
					if (s.turn.error) s.failed = true;
					else if (s.phase === "step1") {
						if (s.turn.text) {
							s.phase = "step2";
							s.turn = null;
						} else s.failed = true; // the run ended and said nothing
					}
				}
				return settle2(s);
			}
			default:
				return s;
		}
	}
	// Step 2 is done when its turn has ended cleanly and README.md itself changed since the turn began.
	function settle2(s) {
		if (s.phase === "step2" && s.turn?.ended && !s.failed && readmeChanged(s.before, s.snap)) {
			s.phase = "step3";
			s.turn = null;
		}
		return s;
	}

	// What the card shows: each step done, current or later; the failed note belongs to the current step.
	function view(s) {
		const now = stepOf(s);
		return {
			phase: s.phase,
			steps: STEPS.map((st) => ({ ...st, state: now > st.n ? "done" : now === st.n ? "now" : "later" })),
			failed: !!s.failed && (s.phase === "step1" || s.phase === "step2"),
			done: s.phase === "done",
			doneText: DONE_TEXT,
			retryHint: RETRY_HINT,
		};
	}

	return { STEPS, DONE_TEXT, RETRY_HINT, README, isReadme, readmeChanged, initial, reduce, view, stepOf };
});
