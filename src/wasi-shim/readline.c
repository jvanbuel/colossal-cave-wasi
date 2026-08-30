/*
 * readline()/add_history() for the WASI build of open-adventure.
 *
 * SPDX-License-Identifier: BSD-2-Clause
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "editline/readline.h"

/* advent.h's LINESIZE, kept local so the shim stays independent of it. */
#define SHIM_LINESIZE 1024

char *readline(const char *prompt) {
	if (prompt != NULL && prompt[0] != '\0') {
		fputs(prompt, stdout);
	}
	/* The prompt has to reach the terminal before we block on input:
	 * nothing else will flush it, and the player would be staring at a
	 * bare cursor. */
	fflush(stdout);

	char *line = malloc(SHIM_LINESIZE + 1);
	if (line == NULL) {
		return NULL;
	}
	if (fgets(line, SHIM_LINESIZE + 1, stdin) == NULL) {
		free(line);
		return NULL;
	}
	line[strcspn(line, "\n")] = '\0';
	return line;
}

void add_history(const char *line) { (void)line; }
