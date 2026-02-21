import { tokenize } from "sugar-high";

/** Sugar-high token type indices → CSS classes */
const tokenClasses = [
	"sh-identifier", // 0
	"sh-keyword", // 1
	"sh-string", // 2
	"sh-class", // 3
	"sh-property", // 4
	"sh-entity", // 5
	"sh-jsxliterals", // 6
	"sh-sign", // 7
	"sh-comment", // 8
	"sh-break", // 9
	"sh-space", // 10
] as const;

export interface CodeToken {
	type: string;
	value: string;
}

export interface CodeLine {
	tokens: CodeToken[];
}

/** Tokenize code into lines of typed tokens for React rendering */
export function tokenizeCode(code: string): CodeLine[] {
	const tokens = tokenize(code);
	const lines: CodeLine[] = [{ tokens: [] }];

	for (const [type, value] of tokens) {
		if (type === 9) {
			// break = newline
			lines.push({ tokens: [] });
		} else {
			const last = lines[lines.length - 1];
			if (last) {
				last.tokens.push({
					type: tokenClasses[type] ?? "sh-identifier",
					value,
				});
			}
		}
	}

	return lines;
}
