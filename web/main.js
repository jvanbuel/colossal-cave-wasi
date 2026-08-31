/*
 * Boot the game: wire a DOM terminal to whichever build of the component this
 * browser can run, and start it.
 */

import { Terminal } from './terminal.js';
import { Session } from '../host/session.js';
import { chooseEngine, start } from '../host/start.js';

const terminal = new Terminal();

/* ?engine=preview1 forces the fallback on a browser that could run the
 * component; the tests use it to exercise both on one machine. */
const forced = new URLSearchParams(location.search).get('engine');
const engine = forced === 'preview1' || forced === 'preview3' ? forced : chooseEngine();

const LABELS = {
	preview3: 'wasi:cli@0.3.0 component · JSPI',
	preview1: 'wasi_snapshot_preview1 · asyncify',
};

async function main() {
	const session = new Session({
		onOutput: (text, stream) => terminal.write(text, stream),
		/* Only the status light tracks this.  Disabling the input while the
		 * game thinks would drop and re-raise the on-screen keyboard on
		 * every single turn, and typing ahead of the game is what a terminal
		 * does anyway — the session queues whatever arrives early. */
		onBlocked: (blocked) => {
			terminal.setStatus(
				blocked ? 'waiting for your command' : 'running',
				blocked ? 'waiting' : 'running',
			);
		},
	});
	terminal.onLine = (line) => session.sendLine(line);

	terminal.setEngine(LABELS[engine]);
	terminal.setStatus('running', 'running');
	terminal.setAcceptingInput(true);

	const code = await start(session, { engine });
	finish(
		code === 0 ? 'the game has ended' : `the game exited with code ${code}`,
	);
}

function finish(message) {
	terminal.setAcceptingInput(false);
	terminal.setStatus(message, 'ended');
	terminal.write(`\n[${message} — reload to play again]\n`, 'notice');
}

main().catch((err) => {
	finish('the game stopped');
	terminal.write(`\n${err?.stack ?? err}\n`, 'stderr');
	throw err;
});
