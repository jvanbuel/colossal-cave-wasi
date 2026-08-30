/*
 * Static file server for local play, and for the browser test.
 *
 * The page lives in web/ but pulls the transpiled bindings from dist/ and the
 * WASI host from host/, so this serves the repository root with those three
 * directories exposed and nothing else.
 *
 * Usage: node scripts/serve.js [port]
 */

import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SERVED = ['web', 'dist', 'host'];

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

function resolveRequest(pathname) {
	const path = resolve(join(ROOT, normalize(pathname)));
	const allowed = SERVED.some(
		(dir) => path === join(ROOT, dir) || path.startsWith(join(ROOT, dir) + sep),
	);
	return allowed ? path : null;
}

export function serve(port = 0) {
	const server = createServer(async (req, res) => {
		const url = new URL(req.url, 'http://localhost');
		if (url.pathname === '/') {
			res.writeHead(302, { location: '/web/' }).end();
			return;
		}
		const path = resolveRequest(decodeURIComponent(url.pathname));
		if (path === null) {
			res.writeHead(403, { 'content-type': 'text/plain' }).end('forbidden');
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
	console.log(`serving on http://localhost:${port}/`);
}
