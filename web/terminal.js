/*
 * A very small DOM terminal: an append-only transcript, one input line, and
 * shell-style history on the arrow keys.
 */

const HISTORY_LIMIT = 200;

export class Terminal {
	#screen;
	#form;
	#input;
	#light;
	#statusText;
	#history = [];
	#historyAt = 0;
	#draft = '';
	/** The element new output is appended to, so runs of text coalesce. */
	#tail = null;
	#tailKind = null;

	constructor(root = document) {
		this.#screen = root.getElementById('screen');
		this.#form = root.getElementById('prompt');
		this.#input = root.getElementById('command');
		this.#light = root.getElementById('light');
		this.#statusText = root.getElementById('status-text');

		/** Set by the caller; receives each submitted line. */
		this.onLine = () => {};

		this.#form.addEventListener('submit', (event) => {
			event.preventDefault();
			this.#submit();
		});
		this.#input.addEventListener('keydown', (event) => this.#onKeyDown(event));
		/* Clicking anywhere in the transcript should not steal the caret. */
		this.#screen.addEventListener('click', () => {
			if (window.getSelection()?.isCollapsed !== false) {
				this.focus();
			}
		});
	}

	focus() {
		if (!this.#input.disabled) {
			this.#input.focus();
		}
	}

	/** Append game output. `kind` is 'stdout', 'stderr', 'echo' or 'notice'. */
	write(text, kind = 'stdout') {
		if (text === '') {
			return;
		}
		const atBottom = this.#isScrolledToBottom();
		if (this.#tail === null || this.#tailKind !== kind) {
			this.#tail = document.createElement('span');
			this.#tail.className = kind;
			this.#tailKind = kind;
			this.#screen.append(this.#tail);
		}
		this.#tail.append(text);
		if (atBottom) {
			this.#scrollToBottom();
		}
	}

	setAcceptingInput(accepting) {
		this.#input.disabled = !accepting;
		if (accepting) {
			this.focus();
		}
	}

	/** Name the build that is actually running, in the masthead. */
	setEngine(label) {
		const el = document.getElementById('engine');
		if (el !== null) {
			el.textContent = label;
		}
	}

	setStatus(text, state) {
		this.#statusText.textContent = text;
		this.#light.dataset.state = state;
	}

	#submit() {
		if (this.#input.disabled) {
			return;
		}
		const line = this.#input.value;
		this.#input.value = '';
		/* Echo what was typed where the game's prompt left off, the way a
		 * terminal would. */
		this.write(`${line}\n`, 'echo');
		this.#scrollToBottom();
		this.#remember(line);
		this.onLine(line);
	}

	#remember(line) {
		if (line.trim() !== '' && this.#history.at(-1) !== line) {
			this.#history.push(line);
			if (this.#history.length > HISTORY_LIMIT) {
				this.#history.shift();
			}
		}
		this.#historyAt = this.#history.length;
		this.#draft = '';
	}

	#onKeyDown(event) {
		if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') {
			return;
		}
		if (this.#history.length === 0) {
			return;
		}
		event.preventDefault();
		if (this.#historyAt === this.#history.length) {
			this.#draft = this.#input.value;
		}
		const step = event.key === 'ArrowUp' ? -1 : 1;
		this.#historyAt = Math.min(
			this.#history.length,
			Math.max(0, this.#historyAt + step),
		);
		this.#input.value =
			this.#historyAt === this.#history.length
				? this.#draft
				: this.#history[this.#historyAt];
		/* Put the caret at the end of the recalled command. */
		const end = this.#input.value.length;
		this.#input.setSelectionRange(end, end);
	}

	#isScrolledToBottom() {
		const slack = this.#screen.scrollHeight - this.#screen.clientHeight;
		return this.#screen.scrollTop >= slack - 24;
	}

	#scrollToBottom() {
		this.#screen.scrollTop = this.#screen.scrollHeight;
	}
}
