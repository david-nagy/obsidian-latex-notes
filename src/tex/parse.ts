// Minimal LaTeX tokenizer/parser. Produces a tree that is good enough for
// converting a document subset to markdown; it does not try to be TeX.

export type Node =
	| { t: 'text'; v: string }
	| { t: 'ws'; nl: number }
	| { t: 'par' }
	| { t: 'cmd'; name: string }
	| { t: 'group'; c: Node[] }
	| { t: 'math'; display: boolean; raw: string }
	| { t: 'env'; name: string; c: Node[]; body: string; raw: string }
	| { t: 'special'; v: '&' | '~' | '^' | '_' | '#' }
	| { t: 'verb'; v: string };

// Environments whose body is kept verbatim instead of being parsed.
export const MATH_ENVS = new Set([
	'equation', 'equation*', 'align', 'align*', 'gather', 'gather*', 'multline', 'multline*',
	'flalign', 'flalign*', 'alignat', 'alignat*', 'eqnarray', 'eqnarray*', 'displaymath', 'math',
]);
export const RAW_ENVS = new Set([
	...MATH_ENVS,
	'verbatim', 'verbatim*', 'Verbatim', 'lstlisting', 'minted', 'comment',
	'tikzpicture', 'tikzcd', 'pgfpicture', 'forest', 'circuitikz', 'algorithmic', 'algorithmic*',
]);

export function parse(src: string): Node[] {
	return new Parser(src).parseAll();
}

class Parser {
	i = 0;
	constructor(private s: string) {}

	parseAll(): Node[] {
		return this.parseUntil(null).nodes;
	}

	// Parses until `}` (stop = '}'), `\end{name}` (stop = name) or EOF.
	parseUntil(stop: string | null): { nodes: Node[]; endPos: number } {
		const s = this.s;
		const out: Node[] = [];
		let text = '';
		const flush = () => {
			if (text) out.push({ t: 'text', v: text });
			text = '';
		};
		while (this.i < s.length) {
			const ch = s[this.i]!;
			if (ch === '\\') {
				const start = this.i;
				const name = this.readCmdName();
				if (name === 'begin') {
					const envName = this.peekBraced();
					if (envName !== null) {
						flush();
						out.push(this.parseEnv(envName, start));
						continue;
					}
				} else if (name === 'end') {
					const envName = this.peekBraced();
					if (envName !== null) {
						if (stop !== null && stop !== '}' && envName === stop) {
							flush();
							const endPos = start;
							this.skipBraced();
							return { nodes: out, endPos };
						}
						// Stray or mismatched \end: drop it.
						this.skipBraced();
						continue;
					}
				} else if (name === '(' || name === '[') {
					flush();
					const close = name === '(' ? '\\)' : '\\]';
					const j = s.indexOf(close, this.i);
					const end = j < 0 ? s.length : j;
					out.push({ t: 'math', display: name === '[', raw: s.slice(this.i, end) });
					this.i = j < 0 ? s.length : j + 2;
					continue;
				} else if (name === 'verb' || name === 'verb*') {
					const delim = s[this.i];
					if (delim) {
						const j = s.indexOf(delim, this.i + 1);
						const end = j < 0 ? s.length : j;
						flush();
						out.push({ t: 'verb', v: s.slice(this.i + 1, end) });
						this.i = j < 0 ? s.length : j + 1;
						continue;
					}
				}
				flush();
				out.push({ t: 'cmd', name });
				continue;
			}
			if (ch === '{') {
				flush();
				this.i++;
				out.push({ t: 'group', c: this.parseUntil('}').nodes });
				continue;
			}
			if (ch === '}') {
				this.i++;
				if (stop === '}') {
					flush();
					return { nodes: out, endPos: this.i - 1 };
				}
				continue; // unmatched
			}
			if (ch === '$') {
				flush();
				const display = s[this.i + 1] === '$';
				this.i += display ? 2 : 1;
				const end = this.findMathEnd(display);
				out.push({ t: 'math', display, raw: s.slice(this.i, end) });
				this.i = Math.min(s.length, end + (display ? 2 : 1));
				continue;
			}
			if (ch === '%') {
				flush();
				this.skipComment(out);
				continue;
			}
			if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
				flush();
				let nl = 0;
				while (this.i < s.length) {
					const c = s[this.i]!;
					if (c === '\n') nl++;
					else if (c !== ' ' && c !== '\t' && c !== '\r') break;
					this.i++;
				}
				out.push(nl >= 2 ? { t: 'par' } : { t: 'ws', nl });
				continue;
			}
			if (ch === '&' || ch === '~' || ch === '^' || ch === '_' || ch === '#') {
				flush();
				out.push({ t: 'special', v: ch });
				this.i++;
				continue;
			}
			if (ch === '[' || ch === ']') {
				flush();
				out.push({ t: 'text', v: ch });
				this.i++;
				continue;
			}
			text += ch;
			this.i++;
		}
		flush();
		return { nodes: out, endPos: s.length };
	}

	readCmdName(): string {
		const s = this.s;
		this.i++; // backslash
		const start = this.i;
		while (this.i < s.length && /[A-Za-z@]/.test(s[this.i]!)) this.i++;
		if (this.i === start) {
			// control symbol
			this.i++;
			return s.slice(start, this.i);
		}
		let name = s.slice(start, this.i);
		if (name === 'verb' && s[this.i] === '*') {
			this.i++;
			name = 'verb*';
		}
		return name;
	}

	// If the next non-space chars are `{name}`, return name (without consuming).
	peekBraced(): string | null {
		const m = /^\s*\{([^{}]*)\}/.exec(this.s.slice(this.i, this.i + 200));
		return m ? m[1]!.trim() : null;
	}

	skipBraced() {
		const m = /^\s*\{([^{}]*)\}/.exec(this.s.slice(this.i, this.i + 200));
		if (m) this.i += m[0].length;
	}

	parseEnv(name: string, start: number): Node {
		this.skipBraced();
		const bodyStart = this.i;
		if (RAW_ENVS.has(name)) {
			const end = this.findEnd(name);
			const body = this.s.slice(bodyStart, end.start);
			this.i = end.after;
			return { t: 'env', name, c: [], body, raw: this.s.slice(start, end.after) };
		}
		const { nodes, endPos } = this.parseUntil(name);
		return { t: 'env', name, c: nodes, body: this.s.slice(bodyStart, endPos), raw: this.s.slice(start, this.i) };
	}

	// Finds the matching \end{name} for a raw environment, allowing nesting of the same name.
	findEnd(name: string): { start: number; after: number } {
		const s = this.s;
		const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		const re = new RegExp(`\\\\(begin|end)\\s*\\{${esc}\\}`, 'g');
		re.lastIndex = this.i;
		let depth = 1;
		let m: RegExpExecArray | null;
		while ((m = re.exec(s))) {
			if (isCommented(s, m.index)) continue;
			depth += m[1] === 'begin' ? 1 : -1;
			if (depth === 0) return { start: m.index, after: m.index + m[0].length };
		}
		return { start: s.length, after: s.length };
	}

	findMathEnd(display: boolean): number {
		const s = this.s;
		let j = this.i;
		while (j < s.length) {
			const c = s[j];
			if (c === '\\') {
				j += 2;
				continue;
			}
			if (c === '%') {
				const nl = s.indexOf('\n', j);
				j = nl < 0 ? s.length : nl + 1;
				continue;
			}
			if (c === '$') {
				if (!display) return j;
				if (s[j + 1] === '$') return j;
			}
			// An inline formula never spans a paragraph break.
			if (!display && c === '\n' && /^\n[ \t]*\n/.test(s.slice(j, j + 50))) return j;
			j++;
		}
		return s.length;
	}

	// `%` eats the rest of the line and leading blanks of the next one. A blank
	// line directly after the comment still counts as a paragraph break.
	skipComment(out: Node[]) {
		const s = this.s;
		const nl = s.indexOf('\n', this.i);
		if (nl < 0) {
			this.i = s.length;
			return;
		}
		this.i = nl + 1;
		while (this.i < s.length && (s[this.i] === ' ' || s[this.i] === '\t')) this.i++;
		if (s[this.i] === '\n' || s[this.i] === '\r') {
			const prev = out[out.length - 1];
			if (!prev || prev.t !== 'par') out.push({ t: 'par' });
		}
	}
}

// True if position `pos` is inside a `%` comment on its line.
export function isCommented(s: string, pos: number): boolean {
	const lineStart = s.lastIndexOf('\n', pos - 1) + 1;
	for (let k = lineStart; k < pos; k++) {
		if (s[k] === '\\') {
			k++;
			continue;
		}
		if (s[k] === '%') return true;
	}
	return false;
}

// Removes `%` comments from raw source (used for raw blocks such as math).
export function stripComments(s: string): string {
	return s
		.split('\n')
		.map((line) => {
			for (let k = 0; k < line.length; k++) {
				if (line[k] === '\\') {
					k++;
					continue;
				}
				if (line[k] === '%') return line.slice(0, k);
			}
			return line;
		})
		.join('\n');
}
