/*
 * Minimal stand-in for <editline/readline.h> when building for WASI.
 *
 * open-adventure only uses readline() and add_history() from libedit.  A WASI
 * component has no terminal to put in raw mode and no history file to persist,
 * so line editing and history live in the host instead: in the browser build
 * the DOM supplies an <input> with its own history, and the component just
 * reads whole lines from wasi:cli/stdin.
 *
 * SPDX-License-Identifier: BSD-2-Clause
 */

#ifndef ADVENT_WASI_EDITLINE_READLINE_H
#define ADVENT_WASI_EDITLINE_READLINE_H

/* Print `prompt`, then read one line from stdin.  Returns a malloc'd string
 * without its trailing newline, or NULL on EOF. */
extern char *readline(const char *prompt);

/* No-op: the host owns command history. */
extern void add_history(const char *line);

#endif
