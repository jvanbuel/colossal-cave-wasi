#!/usr/bin/env node
/*
 * Play the game in the terminal you started this from.
 *
 * The same component and the same WASI host as the browser build: only the
 * terminal changes.  `host/` reads lines from a session and writes output
 * back to it; here the session is wired to process.stdin and process.stdout
 * instead of to a DOM input and a transcript element.
 *
 * Needs Node 24 or newer, where JSPI (WebAssembly.Suspending) is on by
 * default — it is what lets the component park on a read of stdin.
 */

import process from 'node:process';
import { ComponentExit, Session, setCurrentSession } from '../host/session.js';

if (typeof WebAssembly.Suspending !== 'function') {
	process.stderr.write(
		`This needs JSPI, which Node ${process.versions.node} does not have.\n` +
			'Use Node 24 or newer, or run the component under a host that ' +
			'speaks WASI 0.3:\n\n' +
			'    wasmtime run build/adventure.component.wasm\n',
	);
	process.exit(1);
}

const session = new Session({
	onOutput: (text, stream) => {
		(stream === 'stderr' ? process.stderr : process.stdout).write(text);
	},
});
setCurrentSession(session);

/* Cooked mode: the terminal does the line editing and the echoing, and hands
 * over whole lines — which is exactly what the game's readline() wants.  The
 * component's isatty() says "terminal" either way, so it never echoes on top
 * of what the terminal already showed. */
process.stdin.on('data', (chunk) => session.sendBytes(chunk));
process.stdin.on('end', () => session.closeInput());

const { run } = await import('../dist/adventure.js');

try {
	await run.run();
	await finish(0);
} catch (err) {
	if (err instanceof ComponentExit || err?.exitError === true) {
		await finish(err.code);
	} else {
		throw err;
	}
}

async function finish(code) {
	process.stdin.destroy();
	/* The game's last words — the score — can still be in the stdout stream
	 * when run() returns, because QUIT reaches exit() before the host has
	 * drained it. */
	await session.flushed();
	/* Exit rather than fall off the end: the component-model runtime can
	 * leave a polling timer behind after the game is done with a stream,
	 * and that would hold the event loop open forever.  Wait for stdout to
	 * flush first — it is a pipe, and so asynchronous, when the output is
	 * being redirected. */
	process.stdout.write('', () => process.exit(code));
}
