#!/usr/bin/env node
/*
 * Play the game in the terminal you started this from.
 *
 * The same builds and the same WASI hosts as the browser: only the terminal
 * changes.  `host/` reads lines from a session and writes output back to it;
 * here the session is wired to process.stdin and process.stdout rather than to
 * a DOM input and a transcript element.
 *
 * Node 24 and up runs the component build through JSPI; anything older falls
 * back to the preview1 one, which needs nothing but WebAssembly.
 * ADVENTURE_ENGINE=preview1 or preview3 forces the choice.
 */

import process from 'node:process';
import { Session } from '../host/session.js';
import { chooseEngine, start } from '../host/start.js';

const forced = process.env.ADVENTURE_ENGINE;
const engine =
	forced === 'preview1' || forced === 'preview3' ? forced : chooseEngine();

const session = new Session({
	onOutput: (text, stream) => {
		(stream === 'stderr' ? process.stderr : process.stdout).write(text);
	},
});

/* Cooked mode: the terminal does the line editing and the echoing and hands
 * over whole lines, which is what the game's readline() wants.  The build's
 * isatty() says "terminal" either way, so it never echoes on top of what the
 * terminal already showed. */
process.stdin.on('data', (chunk) => session.sendBytes(chunk));
process.stdin.on('end', () => session.closeInput());

try {
	await finish(await start(session, { engine }));
} catch (err) {
	if (err?.exitError === true) {
		await finish(err.code);
	} else {
		throw err;
	}
}

async function finish(code) {
	process.stdin.destroy();
	/* The game's last words -- the score -- can still be in flight when the
	 * run returns, because QUIT reaches exit() before the host has drained
	 * them. */
	await session.flushed();
	/* Exit rather than fall off the end: the component-model runtime can
	 * leave a polling timer behind, and that would hold the event loop open
	 * forever.  Wait for stdout to flush first -- it is a pipe, and so
	 * asynchronous, when the output is being redirected. */
	process.stdout.write('', () => process.exit(code));
}
