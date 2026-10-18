// Finds sectioning commands in LaTeX source, with their source positions and
// the same numbering the converter uses (for the outline).

export interface TexHeading {
	text: string; // e.g. "2.1. Objectives"
	num: string; // e.g. "2.1", empty when unnumbered
	level: number; // 1 = part/chapter, 2 = section (or chapter's section), ...
	line: number; // 0-based line of the command
	from: number; // offset of the command
	to: number; // offset after the closing brace of the title
}

const SECTION_RE = /\\(part|chapter|section|subsection|subsubsection)(\*?)\s*(?:\[[^\]]*\])?\s*\{|\\appendix\b/g;

export function scanHeadings(text: string): TexHeading[] {
	const masked = maskComments(text);
	const begin = /\\begin\s*\{document\}/.exec(masked);
	const start = begin ? begin.index + begin[0].length : 0;
	const hasChapters = /\\chapter\*?\s*[{[]/.test(masked);
	const order = hasChapters ? ['chapter', 'section', 'subsection', 'subsubsection'] : ['section', 'subsection', 'subsubsection'];
	const sec = [0, 0, 0, 0, 0];
	let appendix = false;
	const out: TexHeading[] = [];
	const lineStarts = [0];
	for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1);
	const lineOf = (pos: number) => {
		let lo = 0;
		let hi = lineStarts.length - 1;
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			if (lineStarts[mid]! <= pos) lo = mid;
			else hi = mid - 1;
		}
		return lo;
	};

	SECTION_RE.lastIndex = start;
	for (let m = SECTION_RE.exec(masked); m; m = SECTION_RE.exec(masked)) {
		if (!m[1]) {
			appendix = true;
			sec.fill(0);
			continue;
		}
		const name = m[1];
		const star = m[2] === '*';
		const titleStart = m.index + m[0].length;
		const titleEnd = matchBrace(masked, titleStart);
		const title = plainTitle(text.slice(titleStart, titleEnd));
		const depth = name === 'part' ? -1 : order.indexOf(name);
		let num = '';
		if (!star && depth >= 0) {
			sec[depth]!++;
			for (let k = depth + 1; k < sec.length; k++) sec[k] = 0;
			const parts = sec.slice(0, depth + 1).map(String);
			if (appendix) parts[0] = String.fromCharCode(64 + sec[0]!);
			num = parts.join('.');
		}
		out.push({
			text: num ? `${num}. ${title}` : title,
			num,
			level: depth < 0 ? 1 : depth + 2,
			line: lineOf(m.index),
			from: m.index,
			to: Math.min(text.length, titleEnd + 1),
		});
		SECTION_RE.lastIndex = titleEnd;
	}
	return out;
}

// Replaces comment text with spaces so offsets stay valid.
function maskComments(s: string): string {
	return s.replace(/(^|[^\\])(%[^\n]*)/g, (_m, pre: string, c: string) => pre + ' '.repeat(c.length));
}

function matchBrace(s: string, from: number): number {
	let depth = 1;
	for (let i = from; i < s.length; i++) {
		const c = s[i];
		if (c === '\\') {
			i++;
			continue;
		}
		if (c === '{') depth++;
		else if (c === '}' && --depth === 0) return i;
	}
	return s.length;
}

// A readable plain-text version of a section title.
function plainTitle(raw: string): string {
	let s = raw.replace(/\s+/g, ' ');
	for (let k = 0; k < 5; k++) s = s.replace(/\\[A-Za-z@]+\*?(?:\[[^\]]*\])?\{([^{}]*)\}/g, '$1');
	return s
		.replace(/\\([&%$#_{}])/g, '$1')
		.replace(/\\[A-Za-z@]+\*?/g, '')
		.replace(/[{}]/g, '')
		.replace(/~/g, ' ')
		.replace(/---/g, '—')
		.replace(/--/g, '–')
		.replace(/``|''/g, '"')
		.trim();
}
