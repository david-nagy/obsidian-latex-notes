// Text-level helpers: markdown escaping, LaTeX typography, accents and symbols.

// Escapes characters that markdown (or Obsidian) would interpret.
export function escapeMd(s: string): string {
	return s.replace(/[\\`*_[\]<>#|=~$%^!{}]/g, '\\$&');
}

// Applies TeX ligatures for dashes and quotes, then escapes for markdown.
export function texText(s: string): string {
	const typographic = s
		.replace(/---/g, '—')
		.replace(/--/g, '–')
		.replace(/!`/g, '¡')
		.replace(/\?`/g, '¿')
		.replace(/``/g, '“')
		.replace(/''/g, '”')
		.replace(/`/g, '‘');
	return escapeMd(typographic);
}

export function escapeHtml(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Accent commands that take one argument, mapped to combining characters.
export const ACCENTS: Record<string, string> = {
	"'": '́', '`': '̀', '^': '̂', '"': '̈', '~': '̃', '=': '̄',
	'.': '̇', u: '̆', v: '̌', H: '̋', c: '̧', k: '̨', r: '̊',
	d: '̣', b: '̱', t: '͡',
};

export function applyAccent(cmd: string, base: string): string {
	const mark = ACCENTS[cmd];
	if (!mark || !base) return base;
	return (base[0] + mark + base.slice(1)).normalize('NFC');
}

// Argument-less commands that produce a fixed piece of text (already markdown-safe).
export const SYMBOLS: Record<string, string> = {
	ldots: '…', dots: '…', textellipsis: '…',
	textendash: '–', textemdash: '—', textdagger: '†', dag: '†',
	textdaggerdbl: '‡', ddag: '‡', S: '§', P: '¶', copyright: '©',
	textcopyright: '©', textregistered: '®', texttrademark: '™', pounds: '£',
	textsterling: '£', euro: '€', EUR: '€', textbackslash: '\\\\', textasciitilde: '\\~',
	textasciicircum: '\\^', textbar: '\\|', textless: '\\<', textgreater: '\\>', textbullet: '•',
	textdegree: '°', checkmark: '✓', textquoteleft: '‘', textquoteright: '’',
	textquotedblleft: '“', textquotedblright: '”', guillemotleft: '«',
	guillemotright: '»', textperiodcentered: '·', textunderscore: '\\_',
	ss: 'ß', o: 'ø', O: 'Ø', ae: 'æ', AE: 'Æ', oe: 'œ', OE: 'Œ',
	aa: 'å', AA: 'Å', l: 'ł', L: 'Ł', i: 'ı', j: 'ȷ',
	LaTeX: 'LaTeX', TeX: 'TeX', LaTeXe: 'LaTeX2ε', BibTeX: 'BibTeX', eg: 'e.g.', ie: 'i.e.',
	etal: 'et al.',
	'%': '\\%', '$': '\\$', '#': '\\#', '&': '\\&', '_': '\\_', '{': '\\{', '}': '\\}',
	' ': ' ', ',': ' ', ';': ' ', ':': ' ', '!': '', '/': '', '@': '', '-': '',
	thinspace: ' ', enspace: ' ', quad: ' ', qquad: '  ',
	hfill: ' ', hfil: ' ', break: ' ', nobreak: '', allowbreak: '', xspace: ' ', relax: '',
	today: new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }),
};
