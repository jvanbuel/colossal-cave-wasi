/*
 * wasi:cli/stdin@0.3.0, wasi:cli/stdout@0.3.0 and wasi:cli/stderr@0.3.0,
 * implemented against the DOM.
 *
 * Preview 1 exposed these as fd_read/fd_write on descriptors 0, 1 and 2.  In
 * Preview 3 they are `stream<u8>` values in the component model:
 *
 *   read-via-stream:  func() -> tuple<stream<u8>, future<result<_, error-code>>>
 *   write-via-stream: func(data: stream<u8>) -> future<result<_, error-code>>
 *
 * jco lowers `stream<u8>` to an async iterable of Uint8Array chunks and
 * `future<T>` to a promise, so the whole of stdio here is two async functions.
 */

import { currentSession } from './session.js';

/* Reading a stream one element at a time is the default; ask for a whole
 * buffer's worth per read so a screenful of room description costs one
 * round trip and not one per byte. */
const READ_CHUNK = 64 * 1024;

function errorCode(err) {
	return err?.name === 'AbortError' ? 'pipe' : 'io';
}

/** Drain a `stream<u8>` coming from the guest into `sink`. */
async function drain(stream, sink) {
	try {
		for (;;) {
			const { value, done } = await stream.read({ count: READ_CHUNK });
			if (value !== undefined && value.length > 0) {
				sink(value);
			}
			if (done) {
				break;
			}
		}
		return { tag: 'ok', val: undefined };
	} catch (err) {
		console.error('error draining guest stream:', err);
		return { tag: 'err', val: errorCode(err) };
	}
}

export const stdin = {
	readViaStream() {
		const { chunks, ended } = currentSession().stdin();
		/* The future reports how the read side finished.  Nothing on the
		 * page can make stdin fail, so it only ever settles as ok — once
		 * the player's input is exhausted. */
		return [chunks, ended.then(() => ({ tag: 'ok', val: undefined }))];
	},
};

function writer(name) {
	return {
		writeViaStream(data) {
			const session = currentSession();
			return session.trackOutput(
				drain(data, (bytes) => session.receive(bytes, name)),
			);
		},
	};
}

export const stdout = writer('stdout');
export const stderr = writer('stderr');
