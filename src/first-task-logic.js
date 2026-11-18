// The guided first task, pure logic: which step the user is on, from real events. UMD: `FirstTask` in the UI, `require("./first-task-logic")` in tests.
// Three steps, each ticks only when the thing really happened:
//   1. Ask Pi what this project is       -> done when a turn of the chat ends (agent_end) after an assistant reply with text and no error
//   2. Let it add one line to the README -> done when a later turn ends without error AND the Changes list has more files than when it began
//   3. Press Rewind to undo it           -> done when a restore of at least one file finishes in the same chat
// Events (see reduce): start, record { chatId, record } (Pi's records), changes { count }, restore { chatId, files }, retry, reset.
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

	const initial = () => ({ phase: "idle", chatId: null, turn: null, baseline: 0, changes: 0, failed: false });
	const stepOf = (s) => ({ step1: 1, step2: 2, step3: 3, done: 4 })[s.phase] || 0;

	const hasText = (m) => Array.isArray(m?.content) && m.content.some((c) => c && c.type === "text" && String(c.text || "").trim());
	const failedMessage = (m) => m?.stopReason === "error" || !!m?.errorMessage;

	// Next state for one event. Never mutates its input.
	function reduce(prev, ev) {
		const s = { ...prev, turn: prev.turn ? { ...prev.turn } : null };
		switch (ev.type) {
			case "start":
				return { ...initial(), phase: "step1", changes: s.changes };
			case "reset":
				return initial();
			case "retry":
				return { ...s, failed: false };
			case "changes": {
				s.changes = ev.count;
				return settle2(s);
			}
			case "restore":
				if (s.phase === "step3" && ev.files >= 1 && (!s.chatId || s.chatId === ev.chatId)) s.phase = "done";
				return s;
			case "record": {
				if (s.phase !== "step1" && s.phase !== "step2") return s;
				if (s.chatId && ev.chatId !== s.chatId) return s; // only the chat the task started in
				const r = ev.record || {};
				if (r.type === "agent_start") {
					s.chatId = s.chatId || ev.chatId;
					s.turn = { open: true, text: false, error: false, ended: false };
					s.baseline = s.phase === "step2" ? s.changes : s.baseline;
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
	// Step 2 is done when its turn has ended cleanly and a file shows up in Changes that was not there when the turn began.
	function settle2(s) {
		if (s.phase === "step2" && s.turn?.ended && !s.failed && s.changes > s.baseline) {
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

	return { STEPS, DONE_TEXT, RETRY_HINT, initial, reduce, view, stepOf };
});
