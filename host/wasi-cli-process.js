/*
 * wasi:cli/environment@0.3.0 and wasi:cli/exit@0.3.0.
 */

import { ComponentExit } from './session.js';

export const environment = {
	/* argv.  open-adventure runs getopt over this; with just the program
	 * name it takes the plain interactive path. */
	getArguments() {
		return ['advent'];
	},
	getEnvironment() {
		return [];
	},
	getInitialCwd() {
		return undefined;
	},
};

export const exit = {
	exit(status) {
		throw new ComponentExit(status.tag === 'err' ? 1 : 0);
	},
	exitWithCode(code) {
		throw new ComponentExit(code);
	},
};
