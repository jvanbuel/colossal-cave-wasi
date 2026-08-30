# colossal-cave-wasi

Crowther and Woods' *Colossal Cave Adventure* compiled to a WebAssembly
component and played over **WASI Preview 3** — the version of WASI where
standard I/O is a pair of component-model `stream<u8>` values rather than
`fd_read`/`fd_write` on descriptors 0 and 1.

One component, three ways to play it: in a browser tab, in your terminal
under Node, or under any host that speaks WASI 0.3.

The interesting part is what *isn't* here.  A C program that blocks on a line
of input has always been the awkward case for the browser: the usual answers
are [Asyncify](https://emscripten.org/docs/porting/asyncify.html), which
rewrites the module to unwind and rewind its own stack, or a web worker that
parks on `Atomics.wait` and talks to the page over `SharedArrayBuffer`.  With
Preview 3 the component's call into `wasi:cli/stdin` is an async import: it
suspends, control returns to the browser's event loop, and it resumes when a
`keydown` handler pushes a line in.  There is no Asyncify pass, no worker, and
no `SharedArrayBuffer` — so no cross-origin isolation headers either.

```
          ┌───────────────────────────────────────────────────┐
          │ build/adventure.component.wasm                    │
          │ open-adventure 1.22, clang --target=wasm32-wasip3 │
          │ imports wasi:cli/{stdin,stdout,stderr}@0.3.0      │
          │ exports wasi:cli/run@0.3.0                        │
          └───────────────────────────────────────────────────┘
                    │                                  │
      jco transpile │                                  │
                    ▼                                  ▼
  ┌──────────────────────────────────────┐   ┌─────────────────────┐
  │ dist/adventure.js                    │   │ wasmtime, or any    │
  │ stream<u8> -> async iterable         │   │ other WASI 0.3 host │
  │ future<T>  -> Promise                │   └─────────────────────┘
  │ suspension -> WebAssembly.Suspending │
  └──────────────────────────────────────┘
                    │  --map
                    ▼
  ┌───────────────────────────────┐
  │ host/*.js   the WASI 0.3 host │
  └───────────────────────────────┘
           │                        │
           ▼                        ▼
  ┌─────────────────┐    ┌──────────────────────┐
  │ web/terminal.js │    │ cli/adventure.js     │
  │ DOM transcript  │    │ process.stdin/stdout │
  └─────────────────┘    └──────────────────────┘
```

`host/` does not know which one it is running under.  A `Session` takes lines
in and hands output back; the browser fills it from an `<input>` and paints
into a `<div>`, the CLI fills it from `process.stdin` and writes to
`process.stdout`, and the WASI interface modules are the same either way.

## Build

Needs [wasi-sdk 34](https://github.com/WebAssembly/wasi-sdk/releases) (for the
`wasm32-wasip3` sysroot), Node 20+, and Python 3 with PyYAML.

```sh
npm install
make                     # component in build/, JS bindings in dist/
```

If wasi-sdk is somewhere else, pass it: `make WASI_SDK=/path/to/wasi-sdk-34.0`.

## Play

**In a browser.**  Needs JSPI: Chrome or Edge 137+, or Firefox with
`javascript.options.wasm_js_promise_integration` set.  The page says so
plainly if it is missing.

```sh
make serve               # http://localhost:8080
```

**In a terminal, under Node.**  Needs Node 24+, where JSPI is on by default —
no flags.

```sh
make play
make play NODE=/path/to/node24    # if `node` is older
node cli/adventure.js             # or straight, once dist/ is built
```

**In a terminal, without Node.**  The component is a plain WASI 0.3 command,
so any host that speaks Preview 3 can run it — no JS involved:

```sh
wasmtime run build/adventure.component.wasm
```

## Tests

```sh
make check                        # both hosts
make check NODE=/path/to/node24   # ...including the terminal one
make native                       # the same sources as a host binary
```

`make check` plays a few turns of the game in headless Chromium and again
through `cli/adventure.js` as a child process.  The terminal test skips itself,
loudly, on a Node without JSPI.

## How it fits together

**The component.**  `clang --target=wasm32-wasip3` links against the Preview 3
sysroot and emits a component directly — the `wasm-tools component new
--adapt wasi_snapshot_preview1.command.wasm` step that Preview 1 modules need
does not apply here; there is no preview1 module and no adapter.  `jco wit
build/adventure.component.wasm` prints the resulting world.

**The shim.**  Two small files in `src/wasi-shim` are all the game needed:

- `readline.c` stands in for libedit.  Line editing and history belong to the
  host now — the page has an `<input>` — so `readline()` is a prompt, an
  `fflush`, and `fgets`.
- `tty.c` defines `isatty()`.  wasi:cli's streams have no terminal attached,
  so libc says "not a tty", and the game reads that as "input is a script" and
  echoes every command before acting on it — which double-prints each line in
  a terminal that already shows what you typed.  The page *is* an interactive
  terminal, so this answers truthfully.

The game's own sources are unmodified.

**The host.**  `host/` implements the imported interfaces, and the Makefile
points jco's `--map` at them instead of `@bytecodealliance/preview3-shim`
(whose browser build is still stubs).  The whole of stdio is two async
functions:

```js
// wasi:cli/stdin@0.3.0
//   read-via-stream: func() -> tuple<stream<u8>, future<result<_, error-code>>>
readViaStream() {
    const { chunks, ended } = currentSession().stdin();
    return [chunks, ended.then(() => ({ tag: 'ok', val: undefined }))];
}
```

`chunks` is an async generator that yields typed input and otherwise awaits a
promise — resolved by the page's submit handler, or by a `data` event on
`process.stdin`.  That await is the suspension point: `host/session.js` is
where the game stops and the rest of the program keeps running.

## Known gaps

**SAVE and RESUME are compiled out** (`-DADVENT_NOSAVE`), so they answer with
the game's own "Save and resume are disabled."  They go through `fopen()`, and
the browser has no filesystem; a localStorage-backed one is the obvious
substitute, and the descriptor surface the component imports is small enough
to implement — seven methods.  It does not work with jco 1.32.1: an async host
import that returns a *resource* never delivers the handle to the guest, so
the first `descriptor.open-at` hands libc a dangling descriptor and the
component traps in `fclose()`.  The same component saves and resumes correctly
under `wasmtime run --dir .` (48.0.0), so the gap is in the JS host bindings
rather than in the component or in wasi-libc.  `host/wasi-filesystem.js` has
the details and is where a browser-backed directory would go.

**Preview 3 is young.**  wasi-sdk 34, jco 1.32.1 and `@bytecodealliance/preview3-shim`
0.5.0 are all recent, `--async-mode` is still marked experimental in jco, and
the pinned versions are the ones this was built and tested against.

## Layout

```
vendor/open-adventure/   upstream game sources (BSD-2-Clause), unmodified
src/wasi-shim/           readline() and isatty() for the WASI build
host/                    the WASI 0.3 host: streams, clocks, exit, terminals
web/                     the page: terminal widget, styles, boot
cli/adventure.js         the terminal host
dist/                    generated: the transpiled component
test/                    plays the game in Chromium, and in a terminal
scripts/serve.js         static server for local play
```

## Licences

The game is BSD-2-Clause, © 1977, 2005 Will Crowther and Don Woods, with
later work by Eric S. Raymond and contributors; see
`vendor/open-adventure/COPYING`.  The port — the shim, the host and the page —
is under the same licence, in `LICENSE`.
