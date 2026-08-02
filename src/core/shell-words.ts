/**
 * POSIX-aware shell word splitter shared by builtin command parsing and the
 * intent classifier.
 *
 * Quoting semantics (POSIX shell):
 *   - single quotes: every character is literal; backslash never escapes
 *   - double quotes: backslash is special only before $ ` " \ and newline;
 *     before any other char the backslash itself is kept literally
 *   - unquoted: a backslash escapes the next character (a trailing backslash
 *     is kept literally)
 *
 * Whitespace outside quotes separates words.
 */
export interface SplitShellWordsOptions {
	/**
	 * When true, a backslash is always kept literally (never escapes the next
	 * character), in both unquoted and double-quoted contexts. Quotes still
	 * group words. Use for command forms whose arguments are filesystem paths,
	 * where POSIX escaping would mangle Windows-style `C:\Users\...` paths.
	 */
	preserveBackslash?: boolean;
}

export function splitShellWords(input: string, options: SplitShellWordsOptions = {}): string[] {
	const { preserveBackslash = false } = options;
	const words: string[] = [];
	let current = "";
	// Active quote context: undefined (unquoted), "'" (single), or '"' (double).
	let quote: "'" | '"' | undefined;

	// Inside double quotes a backslash only escapes these characters; before
	// any other char the backslash itself is kept literally. (String.fromCharCode
	// is used for the newline entry to avoid escape-sequence ambiguity.)
	const doubleEscapable = new Set(["$", "`", '"', "\\", String.fromCharCode(10)]);

	for (let i = 0; i < input.length; i++) {
		const char = input[i];
		const next = input[i + 1];

		if (quote === "'") {
			// Single quote: everything is literal until the closing quote.
			if (char === "'") {
				quote = undefined;
			} else {
				current += char;
			}
			continue;
		}

		if (quote === '"') {
			if (preserveBackslash && char === "\\") {
				// Backslash is literal even inside double quotes.
				current += "\\";
				continue;
			}
			// Double quote: backslash is special only before $ ` " \ and newline.
			if (char === "\\" && next !== undefined && doubleEscapable.has(next)) {
				current += next;
				i++;
			} else if (char === '"') {
				quote = undefined;
			} else {
				current += char;
			}
			continue;
		}

		// Unquoted.
		if (char === "\\") {
			if (preserveBackslash) {
				current += "\\";
				continue;
			}
			if (next !== undefined) {
				current += next;
				i++;
			} else {
				// A trailing backslash is kept literally.
				current += "\\";
			}
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}
		if (/\s/.test(char)) {
			if (current.length > 0) {
				words.push(current);
				current = "";
			}
			continue;
		}
		current += char;
	}

	// An unterminated quote keeps whatever was collected (best-effort); a
	// trailing backslash was already handled inside the loop.
	if (current.length > 0) {
		words.push(current);
	}
	return words;
}