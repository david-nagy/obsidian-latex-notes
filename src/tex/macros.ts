// Expansion of the document's own macros (\newcommand, \def, \DeclareMathOperator, …) before
// conversion, so they work in text, in math and in diagrams alike. Only simple substitution macros
// are expanded; ones that program TeX (conditionals, counters, nested definitions) are left as they
// are, and show up as unknown commands in the conversion report.

export interface Macro {
	params: number;
	// Default for an optional first argument (\newcommand{\x}[2][default]{…}).
	optional?: string;
	body: string;
	// Ends in \xspace: keep the space that follows the macro.
	keepSpace?: boolean;
}

export type Macros = Map<string, Macro>;

// Commands whose definitions are copied unexpanded.
const DEFINERS = new Set(['newcommand', 'renewcommand', 'providecommand', 'DeclareRobustCommand', 'DeclareMathOperator', 'def', 'gdef', 'edef', 'xdef']);

// Bodies that program TeX rather than abbreviate text; expanding them would produce nonsense.
const UNSAFE = /\\(?:if(?!f(?![a-zA-Z@]))[a-zA-Z@]*|fi|else|or|expandafter|csname|endcsname|[egx]?def|let|futurelet|noexpand|unexpanded|newcommand|renewcommand|providecommand|makeatletter|makeatother)(?![a-zA-Z@])/;

// The common "is this argument empty?" test, \ifx\relax#1\relax … \else … \fi (or with
// \detokenize), which optional-argument macros use. It's evaluated during expansion.
const EMPTY_TEST = /\\if(?:x\s*\\relax|\s*\\relax\s*\\detokenize\s*\{)\s*#(\d)\s*\}?\s*\\relax([\s\S]*?)(?:\\else(?![a-zA-Z@])([\s\S]*?))?\\fi(?![a-zA-Z@])/g;

const VERBATIM = /^\\begin\s*\{(verbatim\*?|Verbatim\*?|lstlisting|minted|comment)\}/;

// Limits against documents that expand forever or explode in size.
const MAX_DEPTH = 32;
const MAX_EXPANSIONS = 20000;

function skipSpace(s: string, i: number): number {
	while (i < s.length && (s[i] === ' ' || s[i] === '\t' || s[i] === '\n' || s[i] === '\r')) i++;
	return i;
}

// One argument at s[i]: a balanced {…} group (returned without its braces), a control sequence or a
// single character. Returns null at the end of the text or an unbalanced group.
function readArg(s: string, i: number): { value: string; end: number } | null {
	i = skipSpace(s, i);
	if (i >= s.length) return null;
	if (s[i] === '{') {
		let depth = 0;
		for (let j = i; j < s.length; j++) {
			if (s[j] === '\\') j++;
			else if (s[j] === '{') depth++;
			else if (s[j] === '}' && --depth === 0) return { value: s.slice(i + 1, j), end: j + 1 };
		}
		return null;
	}
	if (s[i] === '\\') {
		const m = /^\\([a-zA-Z@]+|.)/.exec(s.slice(i, i + 64));
		return m ? { value: m[0], end: i + m[0].length } : null;
	}
	if (s[i] === '}') return null;
	return { value: s[i]!, end: i + 1 };
}

// An optional [...] argument at s[i], respecting braces.
function readOptional(s: string, i: number): { value: string; end: number } | null {
	const j = skipSpace(s, i);
	if (s[j] !== '[') return null;
	let depth = 0;
	for (let k = j + 1; k < s.length; k++) {
		if (s[k] === '\\') k++;
		else if (s[k] === '{') depth++;
		else if (s[k] === '}') depth--;
		else if (s[k] === ']' && depth === 0) return { value: s.slice(j + 1, k), end: k + 1 };
	}
	return null;
}

// Reads the definition starting at a definer command; returns the macro and where it ends.
function readDefinition(s: string, cmd: string, start: number): { name: string; macro: Macro | null; end: number } | null {
	let i = start;
	if (s[i] === '*') i++;
	if (cmd === 'def' || cmd === 'gdef' || cmd === 'edef' || cmd === 'xdef') {
		const m = /^\s*\\([a-zA-Z@]+)((?:#\d)*)\s*\{/.exec(s.slice(i, i + 200));
		if (!m) return null;
		const body = readArg(s, i + m[0].length - 1);
		if (!body) return null;
		const params = m[2]!.length / 2;
		return { name: m[1]!, macro: cmd === 'def' || cmd === 'gdef' ? { params, body: body.value } : null, end: body.end };
	}
	const nameArg = readArg(s, i);
	if (!nameArg || !/^\\[a-zA-Z@]+$/.test(nameArg.value.trim())) return null;
	const name = nameArg.value.trim().slice(1);
	i = nameArg.end;
	if (cmd === 'DeclareMathOperator') {
		const text = readArg(s, i);
		if (!text) return null;
		const star = s[start] === '*';
		return { name, macro: { params: 0, body: `\\operatorname${star ? '*' : ''}{${text.value}}` }, end: text.end };
	}
	let params = 0;
	let optional: string | undefined;
	const n = readOptional(s, i);
	if (n) {
		params = parseInt(n.value.trim(), 10) || 0;
		i = n.end;
		const d = readOptional(s, i);
		if (d) {
			optional = d.value;
			i = d.end;
		}
	}
	const body = readArg(s, i);
	if (!body) return null;
	return { name, macro: { params, optional, body: body.value }, end: body.end };
}

// The macros a document defines, anywhere in it. Later definitions win, except \providecommand.
// Package macros that MathJax lacks, mapped to ones it has. A document's own definitions win.
const BUILTIN: [string, Macro][] = [['bm', { params: 1, body: '\\boldsymbol{#1}' }]];

export function collectMacros(src: string): Macros {
	// As in TeX, a comment also removes its line break and the next line's indentation, so macro
	// bodies written over several lines with trailing % don't gain paragraph breaks.
	const s = src.replace(/(^|[^\\])%[^\n]*(?:\n[ \t]*)?/g, '$1');
	const macros: Macros = new Map(BUILTIN);
	const re = /\\(newcommand|renewcommand|providecommand|DeclareRobustCommand|DeclareMathOperator|def|gdef|edef|xdef)(?![a-zA-Z@])/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(s))) {
		const def = readDefinition(s, m[1]!, re.lastIndex);
		if (!def) continue;
		re.lastIndex = def.end;
		if (!def.macro || UNSAFE.test(def.macro.body.replace(EMPTY_TEST, ''))) {
			macros.delete(def.name);
			continue;
		}
		if (m[1] === 'providecommand' && macros.has(def.name)) continue;
		const body = def.macro.body.replace(/\\xspace\s*$/, '');
		macros.set(def.name, { ...def.macro, body, keepSpace: body !== def.macro.body });
	}
	return macros;
}

// Replaces uses of the macros in src with their bodies, recursively. Comments, verbatim text and the
// definitions themselves are left untouched.
export function expandMacros(src: string, macros: Macros): string {
	if (!macros.size) return src;
	let budget = MAX_EXPANSIONS;
	const limit = src.length * 8 + 200000;

	const run = (s: string, depth: number): string => {
		let out = '';
		let i = 0;
		while (i < s.length) {
			if (out.length > limit) throw new Error('macro expansion too large');
			const c = s[i]!;
			if (c === '%') {
				const nl = s.indexOf('\n', i);
				const end = nl < 0 ? s.length : nl;
				out += s.slice(i, end);
				i = end;
				continue;
			}
			if (c !== '\\') {
				out += c;
				i++;
				continue;
			}
			const cm = /^\\([a-zA-Z@]+|.)/.exec(s.slice(i, i + 64));
			if (!cm) {
				out += c;
				i++;
				continue;
			}
			const name = cm[1]!;
			let j = i + cm[0].length;
			if (name === 'begin') {
				const v = VERBATIM.exec(s.slice(i, i + 40));
				if (v) {
					const endTag = `\\end{${v[1]}}`;
					const e = s.indexOf(endTag, i);
					const stop = e < 0 ? s.length : e + endTag.length;
					out += s.slice(i, stop);
					i = stop;
					continue;
				}
			}
			if (name === 'verb' || name === 'lstinline') {
				const d = s[j];
				const e = d ? s.indexOf(d, j + 1) : -1;
				const stop = e < 0 ? j : e + 1;
				out += s.slice(i, stop);
				i = stop;
				continue;
			}
			if (DEFINERS.has(name)) {
				const def = readDefinition(s, name, j);
				const stop = def ? def.end : j;
				out += s.slice(i, stop);
				i = stop;
				continue;
			}
			const macro = macros.get(name);
			if (!macro || depth >= MAX_DEPTH || budget <= 0) {
				out += cm[0];
				i = j;
				continue;
			}
			// TeX skips the spaces after a control word.
			const letters = /^[a-zA-Z@]/.test(name);
			if (letters && !macro.keepSpace) j = skipSpaceNoPar(s, j);
			const args: string[] = [];
			let ok = true;
			let first = 0;
			if (macro.optional !== undefined) {
				const o = readOptional(s, j);
				args.push(o ? o.value : macro.optional);
				if (o) j = o.end;
				first = 1;
			}
			for (let k = first; k < macro.params; k++) {
				const a = readArg(s, j);
				if (!a) {
					ok = false;
					break;
				}
				args.push(a.value);
				j = a.end;
			}
			if (!ok) {
				out += cm[0];
				i += cm[0].length;
				continue;
			}
			budget--;
			let repl = macro.body.replace(EMPTY_TEST, (_m, k: string, then: string, otherwise: string | undefined) =>
				(args[Number(k) - 1] ?? '').trim() ? (otherwise ?? '') : then,
			);
			repl = repl.replace(/##|#(\d)/g, (all, k: string | undefined) => (k ? args[Number(k) - 1] ?? '' : '#'));
			repl = run(repl, depth + 1);
			// Keep a following letter from fusing with a trailing control word (\R x -> \mathbb{R}x is fine,
			// but \foo x -> \alphax is not).
			if (/\\[a-zA-Z@]+$/.test(repl) && /^[a-zA-Z@]/.test(s[j] ?? '')) repl += ' ';
			out += repl;
			i = j;
		}
		return out;
	};

	try {
		return run(src, 0);
	} catch {
		return src;
	}
}

// Like skipSpace, but leaves a blank line alone: TeX reads it as a paragraph break.
function skipSpaceNoPar(s: string, i: number): number {
	let newline = -1;
	while (i < s.length) {
		const c = s[i];
		if (c === '\n') {
			if (newline >= 0) return newline;
			newline = i;
		} else if (c !== ' ' && c !== '\t' && c !== '\r') break;
		i++;
	}
	return i;
}
