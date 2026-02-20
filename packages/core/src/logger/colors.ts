// =============================================================================
// ANSI color helpers — respects NO_COLOR env and non-TTY streams
// =============================================================================

const enabled =
	typeof process !== "undefined" && process.stdout?.isTTY === true && !process.env.NO_COLOR;

function wrap(code: number, closeCode: number) {
	return enabled ? (s: string) => `\x1b[${code}m${s}\x1b[${closeCode}m` : (s: string) => s;
}

export const bold = wrap(1, 22);
export const dim = wrap(2, 22);
export const red = wrap(31, 39);
export const yellow = wrap(33, 39);
export const blue = wrap(34, 39);
export const magenta = wrap(35, 39);
