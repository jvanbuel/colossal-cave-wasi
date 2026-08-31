/*
 * The bridge between a terminal — the page's, or the one the process was
 * started from — and the component's WASI Preview 3 streams.
 *
 * A `Session` owns one run of the game.  Nothing in this directory knows
 * whether it is running in a browser or under Node: `web/main.js` and
 * `cli/adventure.js` each build a session over their own terminal, and the
 * WASI interface modules here are stateless adapters over whichever session
 * is current.  (Current, rather than passed in, because jco's generated
 * bindings import these modules statically.)
 */

/** @type {Session | null} */
let current = null;

/** The session the WASI host modules are currently serving. */
export function currentSession() {
	if (current === null) {
		throw new Error(
			'no active session: call setCurrentSession() before running the component',
		);
	}
	return current;
}

export function setCurrentSession(session) {
	current = session;
}

function deferred() {
	let resolve;
	const promise = new Promise((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

/** Thrown by wasi:cli/exit to unwind the component. */
export class ComponentExit extends Error {
	exitError = true;

	constructor(code) {
		super(`component exited with code ${code}`);
		this.code = code;
	}
}

export class Session {
	/** Input bytes the game has not consumed yet. */
	#pending = [];
	/** Resolver for a read that is parked waiting on the player. */
	#parked = null;
	#inputClosed = false;
	#encoder = new TextEncoder();
	/* One decoder per output stream: a UTF-8 sequence can be split across
	 * chunks, and a stateful decoder stitches it back together. */
	#decoders = new Map();
	#blocked = false;
	/** Promises for the output streams the adapters are draining. */
	#outputs = [];
	/** Counts output chunks, so `flushed()` can tell when they stop. */
	#received = 0;

	/**
	 * @param {object} handlers
	 * @param {(text: string, stream: 'stdout'|'stderr') => void} handlers.onOutput
	 * @param {(blocked: boolean) => void} [handlers.onBlocked] called when the
	 *   game starts or stops waiting for input
	 */
	constructor({ onOutput, onBlocked } = {}) {
		this.onOutput = onOutput ?? (() => {});
		this.onBlocked = onBlocked ?? (() => {});
	}

	/** True while the component is parked on a read of stdin. */
	get isWaitingForInput() {
		return this.#blocked;
	}

	/** Feed one line typed by the player to the game. */
	sendLine(line) {
		this.send(`${line}\n`);
	}

	/** Feed raw text to the game's stdin. */
	send(text) {
		this.sendBytes(this.#encoder.encode(text));
	}

	/** Feed raw bytes to the game's stdin, as a terminal would. */
	sendBytes(bytes) {
		if (this.#inputClosed || bytes.length === 0) {
			return;
		}
		this.#pending.push(bytes);
		this.#wake();
	}

	/** Signal end-of-input; the game sees EOF and exits. */
	closeInput() {
		this.#inputClosed = true;
		this.#wake();
	}

	#wake() {
		const parked = this.#parked;
		this.#parked = null;
		parked?.resolve();
	}

	#setBlocked(blocked) {
		if (this.#blocked !== blocked) {
			this.#blocked = blocked;
			this.onBlocked(blocked);
		}
	}

	/* ---- the push side ----
	 *
	 * stdin as an async iterable of byte chunks, plus a promise that settles
	 * when that iterable is exhausted.
	 *
	 * This is where Preview 3 earns its keep: awaiting here parks the
	 * component's task and returns control to the browser's event loop, so
	 * the page stays responsive while the game waits for a command.  There
	 * is no asyncify pass and no worker blocking on Atomics.wait.
	 */
	stdin() {
		const ended = deferred();
		const self = this;
		async function* chunks() {
			try {
				for (;;) {
					if (self.#pending.length > 0) {
						yield self.#pending.shift();
						continue;
					}
					if (self.#inputClosed) {
						return;
					}
					const parked = deferred();
					self.#parked = parked;
					self.#setBlocked(true);
					await parked.promise;
					self.#setBlocked(false);
				}
			} finally {
				self.#setBlocked(false);
				ended.resolve();
			}
		}
		return { chunks: chunks(), ended: ended.promise };
	}

	/* ---- the pull side ----
	 *
	 * Preview 1's fd_read has to be answered with bytes there and then, so
	 * that host reaches into the queue rather than being handed a stream.
	 */

	get isInputClosed() {
		return this.#inputClosed;
	}

	hasInput() {
		return this.#pending.length > 0;
	}

	/** Take up to `max` queued bytes, or null if there are none. */
	takeInput(max) {
		if (this.#pending.length === 0 || max === 0) {
			return null;
		}
		const head = this.#pending[0];
		if (head.length <= max) {
			return this.#pending.shift();
		}
		this.#pending[0] = head.subarray(max);
		return head.subarray(0, max);
	}

	/** Settles once there is input to take, or stdin has closed. */
	async waitForInput() {
		if (this.#pending.length > 0 || this.#inputClosed) {
			return;
		}
		/* Hold the deferred locally: setBlocked runs the caller's handler,
		 * which is free to supply input right there and then, and #wake
		 * clears the field as it resolves. */
		const parked = deferred();
		this.#parked = parked;
		this.#setBlocked(true);
		await parked.promise;
		this.#setBlocked(false);
	}

	/**
	 * Register an output stream the adapters are draining.  The component
	 * can still have bytes in flight when `run` returns — the game's last
	 * words, usually — so a host that is about to tear down (a CLI on its
	 * way to process.exit) waits for these first.
	 */
	trackOutput(drained) {
		this.#outputs.push(drained);
		return drained;
	}

	/** Settles once the component has no more output to hand over. */
	async flushed() {
		/* The tidy case: every stream the adapters are draining closes. */
		const closed = Promise.all(this.#outputs);
		/* But a component that leaves through wasi:cli/exit — which is what
		 * QUIT does — never closes them, so also stop once two turns of the
		 * event loop go by without a byte arriving. */
		const quiet = (async () => {
			for (let seen = -1; seen !== this.#received; ) {
				seen = this.#received;
				await new Promise((resume) => setTimeout(resume));
				await new Promise((resume) => setTimeout(resume));
			}
		})();
		await Promise.race([closed, quiet]);
	}

	/** Called by the stdout/stderr adapters for each chunk the game writes. */
	receive(bytes, stream) {
		this.#received++;
		let decoder = this.#decoders.get(stream);
		if (decoder === undefined) {
			decoder = new TextDecoder('utf-8');
			this.#decoders.set(stream, decoder);
		}
		const text = decoder.decode(bytes, { stream: true });
		if (text !== '') {
			this.onOutput(text, stream);
		}
	}
}
