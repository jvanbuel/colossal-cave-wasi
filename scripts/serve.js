/*
 * Static file server for local play, and for the browser test.
 *
 * The page lives in web/ but pulls the transpiled bindings from dist/ and the
 * WASI host from host/, so by default this serves the repository root with
 * those three directories exposed and nothing else, and redirects / into
 * web/.  Point it at _site instead (`make check-site`) and it serves that
 * whole tree, exactly as GitHub Pages would.
 *
 * Usage: node scripts/serve.js [port] [root]
 */

import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(fileURLToPath(new URL('..', import.meta.url)));
/* Only these directories of the repository are web content. */
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

function under(root, path) {
	return path === root || path.startsWith(root + sep);
}

/**
 * @param {number} port
 * @param {string} [root] a directory to serve whole; defaults to the
 *   repository, of which only SERVED is exposed
 */
export function serve(port = 0, root) {
	const base = root === undefined ? REPO : resolve(root);
	const allow = (path) =>
		root === undefined
			? SERVED.some((dir) => under(join(REPO, dir), path))
			: under(base, path);

	const server = createServer(async (req, res) => {
		const url = new URL(req.url, 'http://localhost');
		/* Without a root of its own, the repository has no index at / . */
		if (url.pathname === '/' && root === undefined) {
			res.writeHead(302, { location: '/web/' }).end();
			return;
		}
		const path = resolve(join(base, normalize(decodeURIComponent(url.pathname))));
		if (!allow(path)) {
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
	const server = await serve(Number(process.argv[2] ?? 8080), process.argv[3]);
	const { port } = server.address();
	console.log(`serving on http://localhost:${port}/`);
}
