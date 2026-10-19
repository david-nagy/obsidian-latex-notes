import { stripComments } from './parse';

// Diagram environments that a `tikz` code block plugin (TikZJax, TikZJax Next) can draw, with the
// package each one needs beyond TikZ itself.
export const TIKZ_ENVS: Record<string, string> = {
	tikzpicture: '',
	pgfpicture: '',
	tikzcd: 'tikz-cd',
	circuitikz: 'circuitikz',
	forest: 'forest',
};

// Packages worth passing on to a diagram: ones diagrams use and that TikZJax bundles. Anything else
// in the document's preamble (fonts, layout, hyperref, …) would only make the diagram fail.
const DIAGRAM_PACKAGES = new Set([
	'pgfplots', 'pgfplotstable', 'tikz-cd', 'circuitikz', 'chemfig', 'forest', 'siunitx', 'tikz-3dplot',
	'tikz-feynhand', 'amsmath', 'amssymb', 'amsfonts', 'mathtools', 'mathrsfs', 'xparse',
]);

// Preamble commands copied as they are, with how many {} arguments each takes.
const COPIED: Record<string, number> = {
	usetikzlibrary: 1, usepgfplotslibrary: 1, tikzset: 1, pgfplotsset: 1, tikzcdset: 1, definecolor: 3, colorlet: 2,
};

// Reads one balanced {…} group starting at s[i] (after optional spaces); returns its end, or -1.
function group(s: string, i: number): number {
	while (s[i] === ' ' || s[i] === '\n' || s[i] === '\t') i++;
	if (s[i] !== '{') return -1;
	let depth = 0;
	for (; i < s.length; i++) {
		if (s[i] === '\\') i++;
		else if (s[i] === '{') depth++;
		else if (s[i] === '}' && --depth === 0) return i + 1;
	}
	return -1;
}

// The lines a diagram needs from the document's preamble: diagram packages, TikZ libraries, styles
// and colours, in document order.
export function tikzPreamble(preamble: string): string[] {
	const s = stripComments(preamble);
	const lines: string[] = [];
	const re = /\\(usepackage|[a-z]+)\b/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(s))) {
		const name = m[1]!;
		if (name === 'usepackage') {
			const pm = /^\s*(\[[^\]]*\])?\s*\{([^}]*)\}/.exec(s.slice(re.lastIndex));
			if (!pm) continue;
			const pkgs = pm[2]!.split(',').map((p) => p.trim()).filter((p) => DIAGRAM_PACKAGES.has(p));
			if (pkgs.length) lines.push(`\\usepackage${pkgs.length === 1 && pm[1] ? pm[1] : ''}{${pkgs.join(', ')}}`);
			re.lastIndex += pm[0].length;
			continue;
		}
		const n = COPIED[name];
		if (!n) continue;
		let end = re.lastIndex;
		for (let k = 0; k < n && end >= 0; k++) end = group(s, end);
		if (end < 0) continue;
		lines.push(s.slice(m.index, end).trim());
		re.lastIndex = end;
	}
	return lines;
}

// A `tikz` code block for one diagram environment.
export function tikzBlock(env: string, raw: string, preamble: string[]): string {
	const lines = [...preamble];
	const pkg = TIKZ_ENVS[env];
	if (pkg && !lines.some((l) => l.startsWith('\\usepackage') && l.includes(pkg))) lines.push(`\\usepackage{${pkg}}`);
	return [...lines, '\\begin{document}', raw.trim(), '\\end{document}'].join('\n');
}
