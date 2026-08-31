# Build Colossal Cave Adventure as a WASI Preview 3 component and transpile it
# for the browser and for the terminal.
#
# make            - both builds in dist/: the component and the preview1 one
# make play       - play in this terminal
# make wasmtime   - play in this terminal under wasmtime (needs 46+)
# make serve      - serve the page on http://localhost:8080
# make site       - assemble _site/, the tree that goes to GitHub Pages
# make component  - just build/adventure.component.wasm
# make native     - a host build of the same sources, for comparison
# make check      - run the end-to-end tests: both builds, browser and terminal
# make clean

WASI_SDK ?= /opt/wasi-sdk-34.0-x86_64-linux
CLANG     = $(WASI_SDK)/bin/clang
TARGET   ?= wasm32-wasip3

GAME     = vendor/open-adventure
SHIM     = src/wasi-shim
BUILD    = build
DIST     = dist
JCO      = node_modules/.bin/jco
WASM_OPT = node_modules/.bin/wasm-opt
SITE     = _site
NODE     ?= node
# wasmtime 46+ runs the component as-is; 45 and earlier speak an older draft
# of wasi:cli@0.3.0.
WASMTIME ?= wasmtime
# Which Playwright engine the browser test drives: chromium or firefox.
BROWSER  ?= chromium

VERSION  = $(shell sed -n <$(GAME)/NEWS.adoc '/^[0-9]/s/:.*//p' | head -1)

SRCS     = $(GAME)/main.c $(GAME)/init.c $(GAME)/actions.c $(GAME)/score.c \
           $(GAME)/misc.c $(GAME)/saveresume.c $(GAME)/dungeon.c \
           $(SHIM)/readline.c $(SHIM)/tty.c

# -I$(SHIM) puts our editline/readline.h ahead of the real libedit header.
# -D_WASI_EMULATED_SIGNAL because wasi:cli has no signals; the emulation
# turns signal() into a stub so main.c's --logfile handler still compiles.
# -DADVENT_NOSAVE turns SAVE/RESUME into the game's own "Save and resume are
# disabled." message.  They go through fopen(), and a browser has no
# filesystem to put a save file on; see host/wasi-filesystem.js.
CFLAGS  += -std=c99 -O2 -D_DEFAULT_SOURCE -DVERSION=\"$(VERSION)\" \
           -D_WASI_EMULATED_SIGNAL -DADVENT_NOSAVE \
           -I$(SHIM) -I$(GAME) \
           -Wall -Wextra -Wno-unused-parameter
LDFLAGS += -lwasi-emulated-signal

COMPONENT = $(BUILD)/adventure.component.wasm

.PHONY: all bindings component preview1 native check check-browser check-cli \
        check-preview1 check-session check-site clean play serve site wasmtime

all: bindings preview1

# ---------------------------------------------------------------- generated

$(GAME)/dungeon.c $(GAME)/dungeon.h: $(GAME)/adventure.yaml $(GAME)/make_dungeon.py $(GAME)/templates/dungeon.c.tpl $(GAME)/templates/dungeon.h.tpl
	cd $(GAME) && python3 make_dungeon.py

# ---------------------------------------------------------------- component

component: $(COMPONENT)

# clang for a wasip3 target emits a component directly: it links the core
# module against the wasip3 sysroot and runs the component encoder itself, so
# there is no separate `wasm-tools component new --adapt` step the way there
# was for preview1 modules.
$(COMPONENT): $(SRCS) $(GAME)/dungeon.h $(GAME)/advent.h Makefile | $(BUILD)
	$(CLANG) --target=$(TARGET) $(CFLAGS) $(SRCS) $(LDFLAGS) -o $@

$(BUILD):
	mkdir -p $(BUILD)

# ----------------------------------------------------------------- preview1
#
# The same sources again, as a plain core module for hosts without JSPI.
# Asyncify rewrites the module so it can unwind and rewind its own stack, which
# is how a preview1 fd_read gets to wait for the player.  Only the call path
# that reaches fd_read is instrumented, so the rewrite costs a few percent
# rather than the doubling Asyncify is usually blamed for.

preview1: $(DIST)/adventure.p1.wasm

$(BUILD)/adventure.p1.core.wasm: $(SRCS) $(GAME)/dungeon.h $(GAME)/advent.h Makefile | $(BUILD)
	$(CLANG) --target=wasm32-wasip1 $(CFLAGS) $(SRCS) $(LDFLAGS) -o $@

$(DIST)/adventure.p1.wasm: $(BUILD)/adventure.p1.core.wasm | node_modules
	mkdir -p $(DIST)
	$(WASM_OPT) --asyncify \
		--pass-arg=asyncify-imports@wasi_snapshot_preview1.fd_read \
		-O2 $< -o $@

# ----------------------------------------------------------------- bindings

bindings: $(DIST)/adventure.js

$(DIST)/adventure.js: $(COMPONENT) | node_modules
	rm -rf $(DIST)/adventure.js $(DIST)/adventure.core.wasm $(DIST)/interfaces
	$(JCO) transpile $(COMPONENT) --name adventure -o $(DIST) \
		--map 'wasi:cli/stdin@0.3.0=../host/wasi-cli-io.js#stdin' \
		--map 'wasi:cli/stdout@0.3.0=../host/wasi-cli-io.js#stdout' \
		--map 'wasi:cli/stderr@0.3.0=../host/wasi-cli-io.js#stderr' \
		--map 'wasi:cli/environment@0.3.0=../host/wasi-cli-process.js#environment' \
		--map 'wasi:cli/exit@0.3.0=../host/wasi-cli-process.js#exit' \
		--map 'wasi:cli/terminal-input@0.3.0=../host/wasi-cli-terminal.js#terminalInput' \
		--map 'wasi:cli/terminal-output@0.3.0=../host/wasi-cli-terminal.js#terminalOutput' \
		--map 'wasi:cli/terminal-stdin@0.3.0=../host/wasi-cli-terminal.js#terminalStdin' \
		--map 'wasi:cli/terminal-stdout@0.3.0=../host/wasi-cli-terminal.js#terminalStdout' \
		--map 'wasi:cli/terminal-stderr@0.3.0=../host/wasi-cli-terminal.js#terminalStderr' \
		--map 'wasi:clocks/monotonic-clock@0.3.0=../host/wasi-clocks.js#monotonicClock' \
		--map 'wasi:clocks/system-clock@0.3.0=../host/wasi-clocks.js#systemClock' \
		--map 'wasi:filesystem/types@0.3.0=../host/wasi-filesystem.js#types' \
		--map 'wasi:filesystem/preopens@0.3.0=../host/wasi-filesystem.js#preopens'

node_modules:
	npm install

# ------------------------------------------------------------------- native

native: $(BUILD)/advent

$(BUILD)/advent: $(SRCS) $(GAME)/dungeon.h Makefile | $(BUILD)
	cc -std=c99 -O2 -D_DEFAULT_SOURCE -DVERSION=\"$(VERSION)\" \
		-I$(SHIM) -I$(GAME) -Wall -Wextra -Wno-unused-parameter \
		$(SRCS) -o $@

# --------------------------------------------------------------------- play

play: all
	$(NODE) cli/adventure.js

wasmtime: component
	$(WASMTIME) run $(COMPONENT)

serve: all
	$(NODE) scripts/serve.js

# ---------------------------------------------------------------------- site
#
# The page pulls dist/ and host/ from alongside itself, so the published tree
# keeps the repository's shape and the root is a redirect into web/.  That way
# the deployed layout is the one the tests already run against.

site: all
	rm -rf $(SITE)
	mkdir -p $(SITE)
	cp -r web dist host $(SITE)/
	cp scripts/site-index.html $(SITE)/index.html

# -------------------------------------------------------------------- check

# Both builds, in the browser and in the terminal.
check: check-session check-browser check-preview1 check-cli

check-session:
	$(NODE) test/session.test.mjs

# Playwright drives the browser, so these run on any Node.
# `make check-browser BROWSER=firefox` to check the other one.
check-browser: all
	BROWSER=$(BROWSER) node test/browser.test.mjs

# The same suite again on the fallback build, with JSPI taken away.
check-preview1: all
	BROWSER=$(BROWSER) ENGINE=preview1 node test/browser.test.mjs

check-cli: all
	$(NODE) test/cli.test.mjs

# The same browser test, against the tree that gets published.
check-site: site
	SITE_ROOT=$(SITE) BROWSER=$(BROWSER) node test/browser.test.mjs

clean:
	rm -rf $(BUILD) $(DIST) $(SITE)
	rm -f $(GAME)/dungeon.c $(GAME)/dungeon.h
