/*
 * The Session is the one piece both WASI hosts share, and the pull side and
 * the push side have to agree about what is queued.  These are the cases that
 * are awkward to reach through a whole game.
 */

import assert from 'node:assert/strict';
import { Session } from '../host/session.js';

const utf8 = new TextEncoder();
const text = (bytes) => new TextDecoder().decode(bytes);

function check(what, fn) {
	return fn().then(
		() => console.log(`ok - ${what}`),
		(err) => {
			console.error(`not ok - ${what}`);
			throw err;
		},
	);
}

await check('takeInput splits a chunk across reads', async () => {
	const session = new Session({});
	session.send('north\n');
	assert.equal(text(session.takeInput(2)), 'no');
	assert.equal(text(session.takeInput(99)), 'rth\n');
	assert.equal(session.takeInput(99), null);
});

await check('takeInput reports nothing rather than an empty chunk', async () => {
	const session = new Session({});
	assert.equal(session.takeInput(64), null);
	session.send('x');
	assert.equal(session.takeInput(0), null, 'a zero-length read takes nothing');
	assert.equal(text(session.takeInput(64)), 'x');
});

/* onBlocked fires while the session is parking, so a handler that answers
 * immediately resolves the wait before it is awaited.  Both sides have to
 * cope: the terminal ones do not do this, but a test driver does, and it is
 * the sort of thing that otherwise breaks only under load. */
await check('waitForInput survives a handler that answers at once', async () => {
	const session = new Session({
		onBlocked: (blocked) => {
			if (blocked) {
				session.sendLine('xyzzy');
			}
		},
	});
	await session.waitForInput();
	assert.equal(text(session.takeInput(99)), 'xyzzy\n');
});

await check('the stream survives a handler that answers at once', async () => {
	const session = new Session({
		onBlocked: (blocked) => {
			if (blocked) {
				session.sendLine('plugh');
				session.closeInput();
			}
		},
	});
	const { chunks, ended } = session.stdin();
	const seen = [];
	for await (const chunk of chunks) {
		seen.push(text(chunk));
	}
	await ended;
	assert.deepEqual(seen, ['plugh\n']);
});

await check('closed input still yields what was already queued', async () => {
	const session = new Session({});
	session.sendLine('quit');
	session.closeInput();
	await session.waitForInput();
	assert.equal(text(session.takeInput(99)), 'quit\n');
	assert.equal(session.takeInput(99), null);
	assert.equal(session.isInputClosed, true);
});

console.log('\nall checks passed');
