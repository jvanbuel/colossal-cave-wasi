/*
 * Static file server for web/, for local play and the end-to-end test.
 *
 * Usage: node scripts/serve.js [port]
 */

import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../web', import.meta.url)));

const TYPES = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.wasm': 'application/wasm',
	'.map': 'application/json; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.ico': 'image/x-icon',
};

export function serve(port = 0) {
	const server = createServer(async (req, res) => {
		const url = new URL(req.url, 'http://localhost');
		const requested = decodeURIComponent(url.pathname);
		const path = resolve(join(ROOT, normalize(requested)));
		/* Never serve outside web/, whatever the request path claims. */
		if (path !== ROOT && !path.startsWith(ROOT + sep)) {
			res.writeHead(403).end('forbidden');
			return;
		}
		try {
			const info = await stat(path);
			const file = info.isDirectory() ? join(path, 'index.html') : path;
			res.writeHead(200, {
				'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
				'cache-control': 'no-store',
			});
			createReadStream(file).pipe(res);
		} catch {
			res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
		}
	});
	return new Promise((ready) => {
		server.listen(port, '127.0.0.1', () => ready(server));
	});
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const server = await serve(Number(process.argv[2] ?? 8080));
	const { port } = server.address();
	console.log(`serving web/ on http://localhost:${port}/`);
}
