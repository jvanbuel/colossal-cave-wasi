/*
 * Boot the game: wire a DOM terminal to the component's WASI streams and run
 * it.
 */

import { Terminal } from './terminal.js';
import { ComponentExit, Session, setCurrentSession } from '../host/session.js';

const terminal = new Terminal();

function requireJspi() {
	if (typeof WebAssembly.Suspending === 'function') {
		return true;
	}
	terminal.setStatus('unsupported browser', 'ended');
	terminal.write(
		'This browser has no JavaScript Promise Integration — the ' +
			'WebAssembly.Suspending constructor is missing.\n\n' +
			'It is what lets the game stop and wait for a command without ' +
			'freezing the page, so there is no playing without it.\n\n' +
			'Recent versions of Chrome, Edge and Firefox have it switched ' +
			'on. Safari does not have it yet — and on an iPhone or iPad ' +
			'every browser is Safari underneath, so installing a different ' +
			'one there will not help.\n',
		'notice',
	);
	return false;
}

async function main() {
	if (!requireJspi()) {
		return;
	}

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
	setCurrentSession(session);
	terminal.onLine = (line) => session.sendLine(line);

	/* Loaded here rather than at the top of the module so the JSPI check
	 * runs before the bindings touch WebAssembly.Suspending. */
	const { run } = await import('../dist/adventure.js');

	terminal.setStatus('running', 'running');
	terminal.setAcceptingInput(true);
	try {
		await run.run();
		finish('the game has ended');
	} catch (err) {
		if (err instanceof ComponentExit || err?.exitError === true) {
			finish(
				err.code === 0
					? 'the game has ended'
					: `the game exited with code ${err.code}`,
			);
			return;
		}
		finish('the component trapped');
		terminal.write(`\n${err?.stack ?? err}\n`, 'stderr');
		throw err;
	}
}

function finish(message) {
	terminal.setAcceptingInput(false);
	terminal.setStatus(message, 'ended');
	terminal.write(`\n[${message} — reload to play again]\n`, 'notice');
}

main();
