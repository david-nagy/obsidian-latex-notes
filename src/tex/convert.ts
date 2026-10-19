// Converts a LaTeX document (subset) into Obsidian-flavoured markdown.
// Framework independent: everything Obsidian-specific comes in through ConvertOptions.

import { MATH_ENVS, Node, parse, stripComments } from './parse';
import { applyAccent, ACCENTS, escapeHtml, escapeMd, SYMBOLS, texText } from './text';
import { BibEntry, parseName, splitNames } from './bib';
import { TIKZ_ENVS, tikzBlock, tikzPreamble } from './tikz';
import { collectMacros, expandMacros } from './macros';

export interface AssetRef {
	kind: 'image' | 'pdf';
	src: string; // URL usable in <img src> (images)
	path: string; // resolved vault path
}

export interface ConvertOptions {
	bib?: Map<string, BibEntry>;
	// Resolves an \includegraphics path (as written in the source, relative to the main file).
	resolveAsset?: (path: string) => AssetRef | null;
	// A plugin draws ```tikz blocks, so TikZ diagrams are handed to it instead of shown as source.
	tikz?: boolean;
}

export interface Diagnostics {
	unknownCommands: Record<string, number>;
	rawEnvironments: Record<string, number>;
	missingAssets: string[];
	missingCitations: string[];
	missingRefs: string[];
}

export interface ConvertResult {
	markdown: string;
	title: string;
	diagnostics: Diagnostics;
}

// Argument signatures: s = optional star, o = optional [..], m = mandatory {..}.
const IGNORE: Record<string, string> = {
	documentclass: 'om', usepackage: 'om', RequirePackage: 'om', vspace: 'sm', hspace: 'sm',
	setlength: 'mm', addtolength: 'mm', setcounter: 'mm', addtocounter: 'mm', stepcounter: 'm',
	refstepcounter: 'm', pagestyle: 'm', thispagestyle: 'm', pagenumbering: 'm', bibliographystyle: 'm',
	newpage: '', clearpage: '', cleardoublepage: '', pagebreak: 'o', nopagebreak: 'o', linebreak: 'o',
	noindent: '', indent: '', centering: '', raggedright: '', raggedleft: '', small: '', footnotesize: '',
	scriptsize: '', tiny: '', large: '', Large: '', LARGE: '', huge: '', Huge: '', normalsize: '',
	normalfont: '', rmfamily: '', sffamily: '', upshape: '', mdseries: '', bigskip: '', medskip: '',
	smallskip: '', hline: '', toprule: 'o', midrule: 'o', bottomrule: 'o', tableofcontents: '',
	listoffigures: '', listoftables: '', nocite: 'm', graphicspath: 'm', usetikzlibrary: 'm',
	tikzset: 'm', definecolor: 'mmm', colorlet: 'mm', newcommand: 'smoom', renewcommand: 'smoom',
	providecommand: 'smoom', DeclareMathOperator: 'smm', newenvironment: 'smoomm',
	renewenvironment: 'smoomm', theoremstyle: 'm', newcounter: 'mo', numberwithin: 'mm',
	makeatletter: '', makeatother: '', addbibresource: 'om', hypersetup: 'm', captionsetup: 'om',
	setrunningtitle: 'm', frontmatter: '', mainmatter: '', backmatter: '', linenumbers: '',
	nolinenumbers: '', color: 'om', label: 'm', protect: '', phantomsection: '', FloatBarrier: '',
	strut: '', null: '', onecolumn: '', twocolumn: 'o', balance: '', sloppy: '', fussy: '',
	selectfont: '', fontsize: 'mm', baselineskip: '', parindent: '', parskip: '', textwidth: '',
	linewidth: '', columnwidth: '', arraystretch: '', tabcolsep: '', bibfont: '', vfill: '', hrule: '',
	addcontentsline: 'mmm', input: 'm', include: 'm', subcaption: 'om', urlstyle: 'm', ignorespaces: '',
	unskip: '', leavevmode: '', footnotemark: 'o', footnotetext: 'om', bibitem: 'om', vskip: '',
	hskip: '', kern: '', newline: '', newblock: '', typeout: 'm', rule: 'omm', specialrule: 'mmm', boldmath: '', unboldmath: '', addlinespace: 'o',
};

const STYLE_DECL: Record<string, [string, string]> = {
	bf: ['<strong>', '</strong>'], bfseries: ['<strong>', '</strong>'],
	it: ['<em>', '</em>'], itshape: ['<em>', '</em>'], em: ['<em>', '</em>'], sl: ['<em>', '</em>'],
	slshape: ['<em>', '</em>'], tt: ['<code>', '</code>'], ttfamily: ['<code>', '</code>'],
	sc: ['<span class="tex-sc">', '</span>'], scshape: ['<span class="tex-sc">', '</span>'],
};

const STYLE_CMD: Record<string, [string, string]> = {
	emph: ['<em>', '</em>'], textit: ['<em>', '</em>'], textsl: ['<em>', '</em>'],
	textbf: ['<strong>', '</strong>'], texttt: ['<code>', '</code>'], underline: ['<u>', '</u>'],
	uline: ['<u>', '</u>'], sout: ['<s>', '</s>'], st: ['<s>', '</s>'], textsc: ['<span class="tex-sc">', '</span>'],
	textsuperscript: ['<sup>', '</sup>'], textscript: ['<sup>', '</sup>'], textsubscript: ['<sub>', '</sub>'],
	hl: ['<mark>', '</mark>'], textrm: ['', ''], textsf: ['', ''], textnormal: ['', ''], textmd: ['', ''],
	textup: ['', ''], mbox: ['', ''], hbox: ['', ''], fbox: ['', ''], text: ['', ''], makebox: ['', ''],
	framebox: ['', ''], raisebox: ['', ''], scalebox: ['', ''], resizebox: ['', ''], centerline: ['', ''],
	ensuremath: ['', ''],
};
const STYLE_SIG: Record<string, string> = { makebox: 'oom', framebox: 'oom', raisebox: 'moom', scalebox: 'mom', resizebox: 'mmm' };

const THEOREM_NAMES: Record<string, string> = {
	theorem: 'Theorem', thm: 'Theorem', lemma: 'Lemma', lem: 'Lemma', proposition: 'Proposition',
	prop: 'Proposition', corollary: 'Corollary', cor: 'Corollary', definition: 'Definition',
	defn: 'Definition', def: 'Definition', remark: 'Remark', rem: 'Remark', example: 'Example',
	ex: 'Example', conjecture: 'Conjecture', conj: 'Conjecture', claim: 'Claim', assumption: 'Assumption',
	observation: 'Observation', fact: 'Fact', hypothesis: 'Hypothesis', problem: 'Problem',
	exercise: 'Exercise', note: 'Note', question: 'Question', axiom: 'Axiom', notation: 'Notation',
};

const PASSTHROUGH_ENVS: Record<string, string> = {
	center: '', flushleft: '', flushright: '', minipage: 'ooom', adjustbox: 'm', multicols: 'm',
	'multicols*': 'm', landscape: '', samepage: '', raggedright: '', spacing: 'm', singlespace: '',
	onehalfspace: '', doublespace: '', sloppypar: '', small: '', footnotesize: '', scriptsize: '',
	large: '', normalsize: '', document: '', subequations: '', appendices: '', frame: '',
	addmargin: 'om', tcolorbox: 'o', mdframed: 'o', framed: '', otherlanguage: 'm', english: '',
	'otherlanguage*': 'm',
};

const FLOAT_ENVS: Record<string, string> = {
	figure: 'o', 'figure*': 'o', table: 'o', 'table*': 'o', wrapfigure: 'omom', wraptable: 'omom',
	SCfigure: 'oo', sidewaysfigure: 'o', sidewaystable: 'o', algorithm: 'o', 'algorithm*': 'o',
};
const SUBFLOAT_ENVS: Record<string, string> = { subfigure: 'om', subtable: 'om', subcaptionblock: 'om' };
const TABULAR_ENVS: Record<string, string> = {
	tabular: 'om', 'tabular*': 'mom', tabularx: 'mm', tabulary: 'mm', longtable: 'om', array: 'om',
	tblr: 'om',
};

interface Target {
	num: string;
	anchor: string;
	kind: string; // human name, e.g. "Section", "Figure"
	title?: string;
}

class Cursor {
	constructor(public nodes: Node[], public i = 0) {}
	done() {
		return this.i >= this.nodes.length;
	}
	next(): Node {
		return this.nodes[this.i++]!;
	}
	peek(): Node | undefined {
		return this.nodes[this.i];
	}
	rest(): Node[] {
		const r = this.nodes.slice(this.i);
		this.i = this.nodes.length;
		return r;
	}
	skipWs() {
		while (this.peek()?.t === 'ws') this.i++;
	}
	star(): boolean {
		const n = this.peek();
		if (n?.t === 'text' && n.v.startsWith('*')) {
			if (n.v.length === 1) this.i++;
			else this.nodes[this.i] = { t: 'text', v: n.v.slice(1) };
			return true;
		}
		return false;
	}
	opt(): Node[] | null {
		const save = this.i;
		this.skipWs();
		const n = this.peek();
		if (n?.t === 'text' && n.v === '[') {
			let depth = 0;
			const out: Node[] = [];
			for (let j = this.i + 1; j < this.nodes.length; j++) {
				const m = this.nodes[j]!;
				if (m.t === 'par') break;
				if (m.t === 'text' && m.v === '[') depth++;
				if (m.t === 'text' && m.v === ']') {
					if (depth === 0) {
						this.i = j + 1;
						return out;
					}
					depth--;
				}
				out.push(m);
			}
		}
		this.i = save;
		return null;
	}
	arg(): Node[] | null {
		const save = this.i;
		this.skipWs();
		const n = this.peek();
		if (!n) {
			this.i = save;
			return null;
		}
		if (n.t === 'group') {
			this.i++;
			return n.c;
		}
		if (n.t === 'cmd' || n.t === 'math' || n.t === 'special') {
			this.i++;
			return [n];
		}
		if (n.t === 'text' && n.v !== '[' && n.v !== ']') {
			const ch = n.v[0]!;
			if (n.v.length === 1) this.i++;
			else this.nodes[this.i] = { t: 'text', v: n.v.slice(1) };
			return [{ t: 'text', v: ch }];
		}
		this.i = save;
		return null;
	}
	// Reads arguments according to a signature string.
	args(sig: string): { star: boolean; a: (Node[] | null)[] } {
		let star = false;
		const a: (Node[] | null)[] = [];
		for (const c of sig) {
			if (c === 's') star = this.star();
			else if (c === 'o') a.push(this.opt());
			else a.push(this.arg());
		}
		return { star, a };
	}
}

// Accumulates paragraphs and blocks. In inline mode everything collapses to one line.
class Out {
	blocks: string[] = [];
	cur = '';
	constructor(public inlineMode = false) {}
	inline(s: string) {
		this.cur += s;
	}
	space() {
		if (this.cur && !/[\s\u00a0]$/.test(this.cur)) this.cur += ' ';
	}
	par() {
		if (this.inlineMode) return this.space();
		const p = tidy(this.cur);
		if (p) this.blocks.push(escapeLineStart(p));
		this.cur = '';
	}
	block(b: string) {
		if (this.inlineMode) {
			this.space();
			this.cur += b.replace(/\s*\n\s*/g, ' ');
			this.space();
			return;
		}
		this.par();
		if (b) this.blocks.push(b);
	}
	done(): string[] {
		this.par();
		return this.blocks;
	}
	text(): string {
		return tidy(this.cur);
	}
}

function tidy(s: string): string {
	return s.replace(/[ \t\n]+/g, ' ').replace(/ (<br>)/g, '$1').replace(/(<br>) /g, '$1').trim();
}

function escapeLineStart(p: string): string {
	return p.replace(/^(\d+)([.)])(\s)/, '$1\\$2$3').replace(/^([-+])(\s|$)/, '\\$1$2');
}

export function rawText(nodes: Node[] | null | undefined): string {
	if (!nodes) return '';
	return nodes
		.map((n) => {
			switch (n.t) {
				case 'text': return n.v;
				case 'ws': case 'par': return ' ';
				case 'cmd': return '\\' + n.name;
				case 'group': return '{' + rawText(n.c) + '}';
				case 'special': return n.v;
				case 'math': return (n.display ? '$$' : '$') + n.raw + (n.display ? '$$' : '$');
				case 'verb': return n.v;
				case 'env': return n.raw;
			}
		})
		.join('');
}

function unescapePath(s: string): string {
	return s.replace(/\\([_%#&$ ])/g, '$1').trim();
}

const REF_RE = /\uE000([a-zA-Z]+)\uE001([^\uE002]*)\uE002/g;

// Links from documents are only kept for web and mail addresses; anything else
// (javascript:, file:, app:, data:) is shown as plain text.
function safeUrl(url: string): string | null {
	const u = url.trim();
	if (!/^(https?:\/\/|mailto:)/i.test(u)) return null;
	// Percent-encode only what could end the markdown link or open HTML.
	return u.replace(/[\s()<>"'`\\[\]]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
}

function linkMd(label: string, url: string): string {
	const safe = safeUrl(url);
	return safe ? `[${label}](${safe})` : label;
}

// MathJax extensions that create links or set HTML attributes/CSS from the
// document: drop the first argument and keep the formula.
function sanitizeMath(m: string): string {
	return m.replace(/\\(href|class|cssId|style|data)\s*\{[^{}]*\}/g, '');
}

function slug(s: string): string {
	return s.replace(/[^A-Za-z0-9_-]/g, '-');
}

function formatCounter(style: string, n: number): string {
	if (style === 'alph' || style === 'Alph') {
		const a = n >= 1 && n <= 26 ? String.fromCharCode(96 + n) : String(n);
		return style === 'Alph' ? a.toUpperCase() : a;
	}
	// Roman numerals only for 1–3999, as LaTeX; anything else (a document could set any value) stays
	// arabic, so the loop below stays short.
	if ((style === 'roman' || style === 'Roman') && n >= 1 && n < 4000) {
		let r = '';
		let k = n;
		for (const [v, sym] of [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']] as const) {
			while (k >= v) {
				r += sym;
				k -= v;
			}
		}
		return style === 'Roman' ? r.toUpperCase() : r;
	}
	return String(n);
}

function callout(type: string, title: string, blocks: string[], fold = ''): string {
	const body = blocks
		.join('\n\n')
		.split('\n')
		.map((l) => (l ? '> ' + l : '>'))
		.join('\n');
	return `> [!${type}]${fold} ${title}` + (body ? '\n' + body : '');
}

function fence(lang: string, content: string): string {
	const longest = Math.max(2, ...(content.match(/`+/g) ?? []).map((m) => m.length));
	const f = '`'.repeat(longest + 1);
	return `${f}${lang}\n${content.replace(/^\n+|\s+$/g, '')}\n${f}`;
}

function dedent(s: string): string {
	const lines = s.split('\n');
	const indents = lines.filter((l) => l.trim()).map((l) => /^[ \t]*/.exec(l)![0].length);
	const min = indents.length ? Math.min(...indents) : 0;
	return lines.map((l) => l.slice(min)).join('\n');
}

function isListBlock(b: string): boolean {
	return /^(- |\d+\. )/.test(b);
}

export function convert(src: string, opts: ConvertOptions = {}): ConvertResult {
	return new Converter(opts).run(expandMacros(src, collectMacros(src)));
}

class Converter {
	bib: Map<string, BibEntry>;
	sec = [0, 0, 0, 0, 0];
	hasChapters = false;
	tikzHead: string[] = [];
	// The document's own counters (\newcounter), by name.
	counters = new Map<string, number>();
	appendix = false;
	eq = 0;
	fig = 0;
	tab = 0;
	subfig = 0;
	inFloat: 'fig' | 'tab' | null = null;
	inSubfloat = false;
	inTable = false;
	theorems = new Map<string, { title: string; counter: string; numbered: boolean; within?: string }>();
	thmCounters = new Map<string, number>();
	labels = new Map<string, Target>();
	last: Target | null = null;
	footnotes: string[] = [];
	cited: string[] = [];
	citedSet = new Set<string>();
	bibEmitted = false;
	// Entries of a \begin{thebibliography} written in the document itself.
	bibItems = new Map<string, { n: number; authors: string; year: string; body: Node[] }>();
	usesBiblatex = false;
	title: Node[] | null = null;
	author: Node[] | null = null;
	date: Node[] | null = null;
	titleEmitted = false;
	anchorSeq = 0;
	diag: Diagnostics = { unknownCommands: {}, rawEnvironments: {}, missingAssets: [], missingCitations: [], missingRefs: [] };

	constructor(private opts: ConvertOptions & { inlineFootnotes?: boolean }) {
		this.bib = opts.bib ?? new Map<string, BibEntry>();
	}

	run(src: string): ConvertResult {
		const nodes = parse(src);
		this.hasChapters = /\\chapter\*?\s*[{[]/.test(stripComments(src));
		this.usesBiblatex = /\\(addbibresource|printbibliography)\b/.test(stripComments(src));
		const docIdx = nodes.findIndex((n) => n.t === 'env' && n.name === 'document');
		const preamble = docIdx >= 0 ? nodes.slice(0, docIdx) : nodes;
		this.scanPreamble(preamble);
		this.tikzHead = tikzPreamble(src.slice(0, docIdx >= 0 ? src.search(/\\begin\s*\{document\}/) : 0));
		this.scanBibItems(nodes);
		const body = docIdx >= 0 ? (nodes[docIdx] as Extract<Node, { t: 'env' }>).c : nodes;
		const hasMaketitle = body.some((n) => n.t === 'cmd' && n.name === 'maketitle');

		const out = new Out();
		if (!hasMaketitle && this.title) this.emitTitle(out);
		this.walk(docIdx >= 0 ? body : nodes.filter((n) => !(n.t === 'cmd' && preambleOnly.has(n.name))), out);
		if (!this.bibEmitted && this.cited.length) this.emitBibliography(out);
		const blocks = out.done();
		if (this.footnotes.length) blocks.push(this.footnotes.map((f, k) => `[^${k + 1}]: ${f}`).join('\n'));
		const md = this.finish(blocks.join('\n\n') + '\n');
		return { markdown: md, title: this.title ? this.inline(this.title) : '', diagnostics: this.diag };
	}

	// --- preamble -------------------------------------------------------------

	scanPreamble(nodes: Node[]) {
		const cur = new Cursor(nodes);
		while (!cur.done()) {
			const n = cur.next();
			if (n.t !== 'cmd') continue;
			if (n.name === 'title') this.title = cur.args('om').a[1] ?? null;
			else if (n.name === 'author') this.author = cur.args('om').a[1] ?? null;
			else if (n.name === 'date') this.date = cur.arg();
			else if (n.name === 'newtheorem') this.defineTheorem(cur);
			else if (n.name === 'newcounter') this.counters.set(rawText(cur.args('mo').a[0]).trim(), 0);
		}
	}

	defineTheorem(cur: Cursor) {
		const { star, a } = cur.args('smomo');
		const env = rawText(a[0]).trim();
		const shared = rawText(a[1]).trim();
		const title = this.inline(a[2] ?? []);
		const within = rawText(a[3]).trim();
		if (!env) return;
		this.theorems.set(env, { title, counter: shared || env, numbered: !star, within: within || undefined });
	}

	// --- walking --------------------------------------------------------------

	inline(nodes: Node[]): string {
		const o = new Out(true);
		this.walk(nodes, o);
		return o.text();
	}

	blocks(nodes: Node[]): string[] {
		const o = new Out();
		this.walk(nodes, o);
		return o.done();
	}

	walk(nodes: Node[], out: Out) {
		const cur = new Cursor(nodes);
		while (!cur.done()) {
			const n = cur.next();
			switch (n.t) {
				case 'text':
					out.inline(texText(n.v));
					break;
				case 'ws':
					out.space();
					break;
				case 'par':
					out.par();
					break;
				case 'special':
					if (n.v === '~') out.inline(' ');
					else if (n.v === '&') out.space();
					else out.inline(escapeMd(n.v));
					break;
				case 'verb':
					out.inline(`<code>${escapeMd(escapeHtml(n.v))}</code>`);
					break;
				case 'group':
					this.walk(n.c, out);
					break;
				case 'math':
					if (n.display) out.block(this.displayMath(null, n.raw));
					else out.inline(this.inlineMath(n.raw));
					break;
				case 'env':
					this.env(n, out);
					break;
				case 'cmd':
					this.cmd(n.name, cur, out);
					break;
			}
		}
	}

	// Wraps the converted nodes in an inline open/close pair, paragraph by paragraph.
	wrapped(nodes: Node[], out: Out, open: string, close: string) {
		const sub = new Out(out.inlineMode);
		this.walk(nodes, sub);
		if (!sub.blocks.length) {
			const t = sub.text();
			if (!t) return;
			const lead = /^\s/.test(sub.cur) ? ' ' : '';
			const trail = /\s$/.test(sub.cur) ? ' ' : '';
			out.inline(lead + open + t + close + trail);
			return;
		}
		for (const b of sub.done()) out.block(/^[<\w\u00a0-\uffff\\(]/.test(b) && !b.startsWith('<div') ? open + b + close : b);
	}

	cmd(name: string, cur: Cursor, out: Out) {
		if (name in STYLE_DECL) {
			const [o, c] = STYLE_DECL[name]!;
			this.wrapped(cur.rest(), out, o, c);
			return;
		}
		if (name in STYLE_CMD) {
			const [o, c] = STYLE_CMD[name]!;
			const sig = STYLE_SIG[name] ?? 'm';
			const { a } = cur.args(sig);
			this.wrapped(a[a.length - 1] ?? [], out, o, c);
			return;
		}
		if (name in ACCENTS && !(name in SYMBOLS)) {
			const arg = cur.arg();
			const base = arg ? this.inline(arg).replace(/\\(.)/g, '$1') : '';
			out.inline(escapeMd(applyAccent(name, base)));
			return;
		}
		if (name in SYMBOLS) {
			out.inline(SYMBOLS[name]!);
			return;
		}
		switch (name) {
			case '\\':
			case 'newline':
			case 'tabularnewline':
				cur.args('so');
				out.inline('<br>');
				return;
			case 'par':
				out.par();
				return;
			case 'part':
			case 'chapter':
			case 'section':
			case 'subsection':
			case 'subsubsection':
			case 'paragraph':
			case 'subparagraph':
				this.section(name, cur, out);
				return;
			case 'title':
				this.title = cur.args('om').a[1] ?? null;
				return;
			case 'author':
				this.author = cur.args('om').a[1] ?? null;
				return;
			case 'date':
				this.date = cur.arg();
				return;
			case 'maketitle':
				this.emitTitle(out);
				return;
			case 'and':
			case 'And': // NeurIPS-style author separators
			case 'AND':
				out.inline('<br>');
				return;
			case 'thanks':
			case 'footnote': {
				const { a } = cur.args(name === 'footnote' ? 'om' : 'm');
				const text = this.inline(a[a.length - 1] ?? []);
				this.footnotes.push(text);
				const n = this.footnotes.length;
				// Live preview renders blocks separately, so footnotes become tooltips.
				if (this.opts.inlineFootnotes) out.inline(`<sup class="tex-fn" aria-label="${escapeHtml(plainText(text))}">${n}</sup>`);
				else out.inline(`[^${n}]`);
				return;
			}
			case 'textcolor': {
				const { a } = cur.args('omm');
				const color = rawText(a[1]).replace(/[^A-Za-z0-9#]/g, '');
				this.wrapped(a[2] ?? [], out, `<span class="tex-color" style="color: ${color}">`, '</span>');
				return;
			}
			case 'colorbox':
			case 'fcolorbox': {
				const { a } = cur.args(name === 'colorbox' ? 'omm' : 'ommm');
				this.walk(a[a.length - 1] ?? [], out);
				return;
			}
			case 'href': {
				const { a } = cur.args('mm');
				const url = unescapePath(rawText(a[0]));
				out.inline(linkMd(this.inline(a[1] ?? []), url));
				return;
			}
			case 'url':
			case 'nolinkurl': {
				const url = unescapePath(rawText(cur.arg()));
				out.inline(name === 'url' ? linkMd(escapeMd(url), url) : escapeMd(url));
				return;
			}
			case 'ref':
			case 'eqref':
			case 'autoref':
			case 'Autoref':
			case 'cref':
			case 'Cref':
			case 'vref':
			case 'pageref':
			case 'nameref': {
				cur.star();
				const label = rawText(cur.arg()).trim();
				out.inline(`\uE000${name}\uE001${label}\uE002`);
				return;
			}
			case 'label': {
				const label = rawText(cur.arg()).trim();
				this.setLabel(label, out);
				return;
			}
			case 'includegraphics': {
				const { a } = cur.args('som');
				out.inline(this.image(rawText(a[0]), unescapePath(rawText(a[1]))));
				return;
			}
			case 'caption':
			case 'captionof': {
				const { a } = cur.args(name === 'caption' ? 'som' : 'msom');
				const kind = name === 'captionof' ? (rawText(a[0]).includes('table') ? 'tab' : 'fig') : null;
				this.caption(a[a.length - 1] ?? [], out, kind);
				return;
			}
			case 'bibliography':
				cur.arg();
				this.emitBibliography(out);
				return;
			case 'printbibliography':
				cur.opt();
				this.emitBibliography(out);
				return;
			case 'appendix':
				this.appendix = true;
				this.sec = [0, 0, 0, 0, 0];
				return;
			case 'newtheorem':
				this.defineTheorem(cur);
				return;
			case 'item': {
				// \item outside a list
				const label = cur.opt();
				out.par();
				out.inline(label ? `<strong>${this.inline(label)}</strong> ` : '• ');
				return;
			}
			case 'def': {
				cur.next(); // macro name
				while (!cur.done() && cur.peek()!.t !== 'group') cur.next();
				cur.next();
				return;
			}
			case 'let':
				cur.next();
				if (cur.peek()?.t === 'text' && (cur.peek() as { v: string }).v.startsWith('=')) cur.next();
				cur.next();
				return;
		}
		if (/^(cite|Cite|parencite|Parencite|textcite|Textcite|autocite|Autocite|footcite|citealt|citealp|citeauthor|Citeauthor|citeyear|citeyearpar|citet|citep|Citet|Citep|Citealt|Citealp|smartcite|supercite)$/.test(name)) {
			const { star, a } = cur.args('soom');
			out.inline(this.cite(name, star, a[0] ?? null, a[1] ?? null, rawText(a[2])));
			return;
		}
		if (this.counter(name, cur, out)) return;
		if (name in IGNORE) {
			cur.args(IGNORE[name]!);
			return;
		}
		// Unknown command: drop it, but keep the content of directly attached arguments.
		this.diag.unknownCommands[name] = (this.diag.unknownCommands[name] ?? 0) + 1;
		for (;;) {
			const p = cur.peek();
			if (p?.t === 'group') {
				cur.next();
				this.walk(p.c, out);
			} else if (p?.t === 'text' && p.v === '[') {
				cur.opt();
			} else break;
		}
	}

	// --- structure ------------------------------------------------------------

	section(name: string, cur: Cursor, out: Out) {
		const { star, a } = cur.args('som');
		const title = this.inline(a[1] ?? []);
		if (name === 'paragraph' || name === 'subparagraph') {
			out.par();
			out.inline(`<strong>${title}</strong> `);
			return;
		}
		const order = this.hasChapters
			? ['chapter', 'section', 'subsection', 'subsubsection']
			: ['section', 'subsection', 'subsubsection'];
		let depth = order.indexOf(name);
		if (name === 'part') depth = 0;
		const level = Math.min(6, (depth < 0 ? 0 : depth) + 2);
		let num = '';
		if (!star && name !== 'part' && depth >= 0) {
			this.sec[depth]!++;
			for (let k = depth + 1; k < this.sec.length; k++) this.sec[k] = 0;
			const parts = this.sec.slice(0, depth + 1).map(String);
			if (this.appendix) parts[0] = String.fromCharCode(64 + this.sec[0]!);
			num = parts.join('.');
			this.resetTheoremCounters(name);
		}
		const anchor = this.anchorId('sec');
		this.last = { num, anchor, kind: name === 'chapter' ? 'Chapter' : this.appendix && depth === 0 ? 'Appendix' : 'Section', title };
		out.block(`${'#'.repeat(level)} ${num ? num + '. ' : ''}${title} <span class="tex-anchor" id="${anchor}"></span>`);
	}

	emitTitle(out: Out) {
		if (this.titleEmitted) return;
		this.titleEmitted = true;
		if (this.title) out.block(`# ${this.inline(this.title)}`);
		if (this.author) {
			const a = this.inline(this.author);
			if (a) out.block(`<span class="tex-mark-authors"></span>${a}`);
		}
		if (this.date) {
			const d = this.inline(this.date);
			if (d) out.block(`<span class="tex-mark-date"></span>${d}`);
		}
	}

	// Commands on the document's own counters. Built-in counters (section, figure, …) are numbered by
	// the converter itself, so commands on those are ignored.
	counter(name: string, cur: Cursor, out: Out): boolean {
		if (name === 'newcounter') {
			const c = rawText(cur.args('mo').a[0]).trim();
			if (!this.counters.has(c)) this.counters.set(c, 0);
			return true;
		}
		if (name.startsWith('the') && this.counters.has(name.slice(3))) {
			out.inline(String(this.counters.get(name.slice(3))));
			return true;
		}
		const numbered = /^(arabic|roman|Roman|alph|Alph|value)$/.test(name);
		if (!numbered && !/^(setcounter|addtocounter|stepcounter|refstepcounter)$/.test(name)) return false;
		const save = cur.i;
		const c = rawText(cur.arg() ?? []).trim();
		if (!this.counters.has(c)) {
			cur.i = save;
			return false;
		}
		const v = this.counters.get(c)!;
		if (numbered) {
			out.inline(formatCounter(name, v));
		} else if (name === 'setcounter' || name === 'addtocounter') {
			const n = parseInt(rawText(cur.arg()).trim(), 10);
			if (!Number.isNaN(n)) this.counters.set(c, name === 'setcounter' ? n : v + n);
		} else {
			this.counters.set(c, v + 1);
			if (name === 'refstepcounter') {
				const anchor = this.anchorId(c.replace(/[^a-zA-Z0-9-]/g, ''));
				out.inline(`<span class="tex-anchor" id="${anchor}"></span>`);
				this.last = { num: String(v + 1), anchor, kind: '' };
			}
		}
		return true;
	}

	anchorId(prefix: string): string {
		return `tex-${prefix}-${++this.anchorSeq}`;
	}

	setLabel(label: string, out: Out) {
		if (!label) return;
		if (this.last) {
			this.labels.set(label, this.last);
			return;
		}
		const anchor = this.anchorId('label');
		out.inline(`<span class="tex-anchor" id="${anchor}"></span>`);
		this.labels.set(label, { num: '?', anchor, kind: '' });
	}

	resolveRef(kind: string, labelsRaw: string): string {
		const parts = labelsRaw.split(',').map((s) => s.trim()).filter(Boolean);
		return parts
			.map((label) => {
				const t = this.labels.get(label);
				if (!t) {
					this.diag.missingRefs.push(label);
					return '??';
				}
				let text = t.num;
				if (kind === 'eqref') text = `(${t.num})`;
				else if (kind === 'nameref') text = t.title ?? t.num;
				else if (/^(autoref|Autoref|cref|Cref|vref)$/.test(kind)) {
					text = t.kind === 'Equation' ? `Equation (${t.num})` : `${t.kind} ${t.num}`.trim();
				}
				return `<a class="tex-ref" href="#${t.anchor}">${text}</a>`;
			})
			.join(', ');
	}

	// --- environments ---------------------------------------------------------

	env(n: Extract<Node, { t: 'env' }>, out: Out) {
		const name = n.name;
		if (MATH_ENVS.has(name)) {
			out.block(this.displayMath(name, n.body));
			return;
		}
		if (name === 'comment') return;
		if (name === 'verbatim' || name === 'verbatim*' || name === 'Verbatim') {
			out.block(fence('', n.body.replace(/^\[[^\]\n]*\]/, '')));
			return;
		}
		if (name === 'lstlisting') {
			const m = /^\s*\[([^\]]*)\]/.exec(n.body);
			const lang = m ? (/language\s*=\s*\{?([A-Za-z+#]+)/.exec(m[1]!)?.[1] ?? '') : '';
			out.block(fence(lang.toLowerCase(), m ? n.body.slice(m[0].length) : n.body));
			return;
		}
		if (name === 'minted') {
			const m = /^\s*(\[[^\]]*\])?\s*\{([^}]*)\}/.exec(n.body);
			out.block(fence(m?.[2] ?? '', m ? n.body.slice(m[0].length) : n.body));
			return;
		}
		if (name === 'thebibliography') {
			out.block(this.thebibliography(n.c));
			return;
		}
		if (name === 'abstract') {
			out.block(callout('abstract', 'Abstract', this.blocks(n.c)));
			return;
		}
		if (name === 'itemize' || name === 'enumerate' || name === 'description' || name === 'compactitem' || name === 'compactenum' || name === 'inparaenum') {
			out.block(this.list(name, n.c));
			return;
		}
		if (name === 'quote' || name === 'quotation' || name === 'verse') {
			const body = this.blocks(n.c).join('\n\n');
			out.block(body.split('\n').map((l) => (l ? '> ' + l : '>')).join('\n'));
			return;
		}
		if (name in FLOAT_ENVS) {
			this.float(name, n.c, out);
			return;
		}
		if (name in SUBFLOAT_ENVS) {
			const cur = new Cursor(n.c);
			cur.args(SUBFLOAT_ENVS[name]!);
			const prev = this.inSubfloat;
			this.inSubfloat = true;
			this.walk(cur.rest(), out);
			this.inSubfloat = prev;
			out.space();
			return;
		}
		if (name in TABULAR_ENVS) {
			out.block(this.table(name, n));
			return;
		}
		if (name in PASSTHROUGH_ENVS) {
			const cur = new Cursor(n.c);
			cur.args(PASSTHROUGH_ENVS[name]!);
			out.par();
			this.walk(cur.rest(), out);
			out.par();
			return;
		}
		if (name === 'proof') {
			const cur = new Cursor(n.c);
			const opt = cur.opt();
			const blocks = this.blocks(cur.rest());
			const lastB = blocks[blocks.length - 1];
			if (lastB && !lastB.startsWith('$$') && !lastB.startsWith('>') && !isListBlock(lastB)) blocks[blocks.length - 1] = lastB + ' ∎';
			else blocks.push('∎');
			out.block(callout('tex-proof', opt ? this.inline(opt) : 'Proof', blocks));
			return;
		}
		const thmBase = name.replace(/\*$/, '');
		const thm = this.theorems.get(name) ?? (THEOREM_NAMES[thmBase] ? { title: THEOREM_NAMES[thmBase], counter: thmBase, numbered: !name.endsWith('*') } : null);
		if (thm) {
			this.theorem(name, thm, n.c, out);
			return;
		}
		this.raw(name, n.raw, out);
	}

	raw(name: string, raw: string, out: Out) {
		if (this.opts.tikz && name in TIKZ_ENVS) {
			out.block(fence('tikz', tikzBlock(name, raw, this.tikzHead)));
			return;
		}
		this.diag.rawEnvironments[name] = (this.diag.rawEnvironments[name] ?? 0) + 1;
		const tikz = /tikz|pgf|forest|circuit/.test(name);
		const title = tikz ? 'TikZ figure (not rendered)' : `Unsupported: ${escapeMd(name)}`;
		out.block(callout('tex-raw', title, [fence('latex', dedent(raw))], '-'));
	}

	theorem(name: string, thm: { title: string; counter: string; numbered: boolean; within?: string }, nodes: Node[], out: Out) {
		const cur = new Cursor(nodes);
		const opt = cur.opt();
		let num = '';
		if (thm.numbered) {
			const k = (this.thmCounters.get(thm.counter) ?? 0) + 1;
			this.thmCounters.set(thm.counter, k);
			const within = this.theorems.get(thm.counter)?.within ?? thm.within;
			num = within ? `${this.sectionNumber(within)}.${k}` : String(k);
		}
		const anchor = this.anchorId('thm');
		const saved = this.last;
		this.last = { num, anchor, kind: thm.title };
		const body = this.blocks(cur.rest());
		this.last = saved;
		const optText = opt ? ` (${this.inline(opt)})` : '';
		// Classify by whole words of the environment name and its display title
		// ("theorem" contains "rem", so substring matching would call it a remark).
		const words = `${name.replace(/\*$/, '')} ${thm.title}`.toLowerCase();
		const type = /\b(definition|defn|def|notation|axiom)\b/.test(words)
			? 'tex-definition'
			: /\b(remark|rem|note|example|ex|observation)\b/.test(words)
				? 'tex-remark'
				: 'tex-theorem';
		out.block(callout(type, `<span class="tex-anchor" id="${anchor}"></span>${thm.title}${num ? ' ' + num : ''}${optText}`, body));
	}

	sectionNumber(within: string): string {
		const order = this.hasChapters ? ['chapter', 'section', 'subsection'] : ['section', 'subsection', 'subsubsection'];
		const d = Math.max(0, order.indexOf(within));
		return this.sec.slice(0, d + 1).join('.');
	}

	resetTheoremCounters(sectionName: string) {
		for (const [env, t] of this.theorems) {
			if (t.within === sectionName) this.thmCounters.set(t.counter || env, 0);
		}
	}

	list(name: string, nodes: Node[]): string {
		const cur = new Cursor(nodes);
		cur.opt(); // enumitem options
		const items: { label: Node[] | null; nodes: Node[] }[] = [];
		while (!cur.done()) {
			const n = cur.next();
			if (n.t === 'cmd' && n.name === 'item') {
				items.push({ label: cur.opt(), nodes: [] });
			} else if (items.length) items[items.length - 1]!.nodes.push(n);
		}
		const ordered = name === 'enumerate' || name === 'compactenum' || name === 'inparaenum';
		return items
			.map((it, k) => {
				const blocks = this.blocks(it.nodes);
				let marker = ordered ? `${k + 1}. ` : '- ';
				if (it.label) {
					marker = '- ';
					const label = `<strong>${this.inline(it.label)}</strong> `;
					if (blocks.length && !blocks[0]!.startsWith('$$') && !blocks[0]!.startsWith('>')) blocks[0] = label + blocks[0];
					else blocks.unshift(label.trim());
				}
				return renderItem(marker, blocks);
			})
			.join('\n');
	}

	float(name: string, nodes: Node[], out: Out) {
		const cur = new Cursor(nodes);
		cur.args(FLOAT_ENVS[name]!);
		const prev = this.inFloat;
		const prevLast = this.last;
		this.inFloat = name.startsWith('table') || name === 'wraptable' || name === 'sidewaystable' ? 'tab' : 'fig';
		this.subfig = 0;
		this.last = null;
		const blocks = this.blocks(cur.rest());
		this.inFloat = prev;
		this.last = prevLast;
		for (const b of blocks) out.block(b);
	}

	caption(nodes: Node[], out: Out, kind: 'fig' | 'tab' | null) {
		const text = this.inline(nodes);
		if (this.inSubfloat) {
			const letter = String.fromCharCode(97 + this.subfig++);
			const anchor = this.anchorId('subfig');
			const parentNum = String(this.fig + 1);
			this.last = { num: `${parentNum}${letter}`, anchor, kind: 'Figure' };
			out.inline(`<span class="tex-anchor tex-mark-subcaption" id="${anchor}"></span>(${letter}) ${text}`);
			return;
		}
		const k = kind ?? this.inFloat ?? 'fig';
		const num = String(k === 'tab' ? ++this.tab : ++this.fig);
		const label = k === 'tab' ? 'Table' : 'Figure';
		const anchor = this.anchorId(k);
		this.last = { num, anchor, kind: label };
		out.par();
		out.inline(`<span class="tex-anchor tex-mark-caption" id="${anchor}"></span><strong>${label} ${num}:</strong> ${text}`);
		out.par();
	}

	image(optRaw: string, path: string): string {
		let width = '';
		const rel = /width\s*=\s*([\d.]*)\s*\\(textwidth|linewidth|columnwidth|hsize|paperwidth)/.exec(optRaw);
		const abs = /width\s*=\s*([\d.]+)\s*(cm|mm|in|pt|em|px)/.exec(optRaw);
		const scale = /scale\s*=\s*([\d.]+)/.exec(optRaw);
		if (rel) width = `${Math.round(Math.min(1, parseFloat(rel[1] || '1')) * 100)}%`;
		else if (abs) {
			const f: Record<string, number> = { cm: 37.8, mm: 3.78, in: 96, pt: 1.33, em: 16, px: 1 };
			width = `${Math.round(parseFloat(abs[1]!) * f[abs[2]!]!)}px`;
		} else if (scale) width = `${Math.round(Math.min(1, parseFloat(scale[1]!)) * 100)}%`;
		const style = width ? ` style="width: ${width}"` : '';
		const ref = this.opts.resolveAsset?.(path) ?? null;
		if (!ref) {
			this.diag.missingAssets.push(path);
			return `<span class="tex-missing">Missing figure: ${escapeHtml(path)}</span>`;
		}
		if (ref.kind === 'pdf') return `<span class="tex-pdf" data-path="${escapeHtml(ref.path)}"${style}></span>`;
		return `<img class="tex-img" src="${escapeHtml(ref.src)}" alt="${escapeHtml(path)}"${style}>`;
	}

	table(name: string, n: Extract<Node, { t: 'env' }>): string {
		const nested = (nodes: Node[]): boolean =>
			nodes.some((m) => (m.t === 'env' && (m.name in TABULAR_ENVS || m.name in FLOAT_ENVS || /itemize|enumerate|tikz/.test(m.name))) || (m.t === 'group' && nested(m.c)));
		if (nested(n.c)) {
			const o = new Out();
			this.raw(name, n.raw, o);
			return o.done().join('\n\n');
		}
		const cur = new Cursor(n.c);
		cur.args(TABULAR_ENVS[name]!);
		const rows: string[][] = [];
		let row: string[] = [];
		let cell: Node[] = [];
		const prevTable = this.inTable;
		this.inTable = true;
		const endCell = () => {
			row.push(this.inline(cell).replace(/\n/g, ' '));
			cell = [];
		};
		const endRow = () => {
			endCell();
			if (row.some((c) => c.trim())) rows.push(row);
			row = [];
		};
		while (!cur.done()) {
			const m = cur.next();
			if (m.t === 'special' && m.v === '&') endCell();
			else if (m.t === 'cmd' && (m.name === '\\' || m.name === 'tabularnewline')) {
				cur.args('so');
				endRow();
			} else if (m.t === 'cmd' && /^(hline|toprule|midrule|bottomrule|endhead|endfirsthead|endfoot|endlastfoot)$/.test(m.name)) {
				cur.opt();
			} else if (m.t === 'cmd' && /^(cline|hhline)$/.test(m.name)) cur.arg();
			else if (m.t === 'cmd' && m.name === 'cmidrule') {
				cur.opt();
				if (cur.peek()?.t === 'text' && (cur.peek() as { v: string }).v.startsWith('(')) cur.next();
				cur.arg();
			} else if (m.t === 'cmd' && (m.name === 'rowcolor' || m.name === 'cellcolor')) cur.args('om');
			else if (m.t === 'cmd' && m.name === 'addlinespace') cur.opt();
			else if (m.t === 'cmd' && m.name === 'multicolumn') {
				const { a } = cur.args('mmm');
				const span = parseInt(rawText(a[0]), 10) || 1;
				cell.push({ t: 'group', c: a[2] ?? [] });
				for (let k = 1; k < span; k++) {
					endCell();
				}
			} else if (m.t === 'cmd' && m.name === 'multirow') {
				const { a } = cur.args('omomom');
				cell.push({ t: 'group', c: a[a.length - 1] ?? [] });
			} else cell.push(m);
		}
		endRow();
		this.inTable = prevTable;
		if (!rows.length) return '';
		const cols = Math.max(...rows.map((r) => r.length));
		const line = (r: string[]) => '| ' + Array.from({ length: cols }, (_, k) => r[k] ?? '').join(' | ') + ' |';
		return [line(rows[0]!), '|' + ' --- |'.repeat(cols), ...rows.slice(1).map(line)].join('\n');
	}

	// --- math -----------------------------------------------------------------

	inlineMath(raw: string): string {
		let t = sanitizeMath(stripComments(raw)).replace(/\s*\n\s*/g, ' ').trim();
		t = t.replace(/\\label\{[^}]*\}/g, '');
		if (this.inTable) t = t.replace(/\\\|/g, '\\Vert ').replace(/\|/g, '\\vert ');
		return t ? `$${t}$` : '';
	}

	displayMath(env: string | null, body: string): string {
		let b = sanitizeMath(stripComments(body)).trim();
		const base = env ? env.replace(/\*$/, '') : null;
		const numbered = env !== null && !env.endsWith('*') && base !== 'displaymath' && base !== 'math';
		const anchors: string[] = [];
		const number = (chunk: string): string => {
			const labels = [...chunk.matchAll(/\\label\s*\{([^}]*)\}/g)].map((m) => m[1]!.trim());
			let c = chunk.replace(/\\label\s*\{[^}]*\}/g, '');
			const explicit = /\\tag\*?\{([^}]*)\}/.exec(c);
			let num = '';
			if (explicit) num = explicit[1]!;
			else if (numbered && !/\\(nonumber|notag)\b/.test(c) && c.trim()) {
				num = String(++this.eq);
				c = c.replace(/\s+$/, '') + ` \\tag{${num}}`;
			}
			c = c.replace(/\\(nonumber|notag)\b/g, '');
			if (num) {
				const anchor = this.anchorId('eq');
				anchors.push(anchor);
				for (const l of labels) this.labels.set(l, { num, anchor, kind: 'Equation' });
			}
			return c;
		};
		let math: string;
		if (base && /^(align|gather|flalign|alignat|eqnarray|multline)$/.test(base)) {
			let arg = '';
			if (base === 'alignat') {
				const m = /^\s*\{[^}]*\}/.exec(b);
				if (m) {
					arg = m[0].trim();
					b = b.slice(m[0].length);
				}
			}
			const rows = base === 'multline' ? [b] : splitRows(b);
			while (rows.length > 1 && !rows[rows.length - 1]!.trim()) rows.pop();
			const target = base === 'eqnarray' ? 'eqnarray*' : `${base}*`;
			math = `\\begin{${target}}${arg}\n${rows.map(number).map((r) => r.trim()).join(' \\\\\n')}\n\\end{${target}}`;
		} else {
			math = number(b).trim();
		}
		if (!math) return '';
		const anchorHtml = anchors.length ? `<div class="tex-anchor">${anchors.map((a) => `<span id="${a}"></span>`).join('')}</div>\n\n` : '';
		return `${anchorHtml}$$\n${math}\n$$`;
	}

	// --- citations ------------------------------------------------------------

	cite(name: string, star: boolean, opt1: Node[] | null, opt2: Node[] | null, keysRaw: string): string {
		const keys = keysRaw.split(',').map((k) => k.trim()).filter(Boolean);
		let pre = '';
		let post = '';
		if (opt2) {
			pre = this.inline(opt1 ?? []);
			post = this.inline(opt2);
		} else if (opt1) post = this.inline(opt1);
		const lower = name.toLowerCase();
		let mode: 't' | 'p' | 'alt' | 'alp' | 'author' | 'year' | 'yearpar';
		if (lower === 'citet' || lower === 'textcite') mode = 't';
		else if (lower === 'citealt') mode = 'alt';
		else if (lower === 'citealp') mode = 'alp';
		else if (lower === 'citeauthor') mode = 'author';
		else if (lower === 'citeyear') mode = 'year';
		else if (lower === 'citeyearpar') mode = 'yearpar';
		else if (lower === 'cite') mode = this.usesBiblatex ? 'p' : 't';
		else mode = 'p';

		const parts = keys.map((key) => {
			if (!this.citedSet.has(key)) {
				this.citedSet.add(key);
				this.cited.push(key);
			}
			const item = this.bibItems.get(key);
			if (item) {
				const numeric = !item.year;
				return { key, authors: numeric ? `[${item.n}]` : item.authors, year: item.year, missing: false, ref: plainText(this.inline(item.body)), numeric };
			}
			const e = this.bib.get(key);
			if (!e) {
				if (!this.diag.missingCitations.includes(key)) this.diag.missingCitations.push(key);
				return { key, authors: escapeMd(key), year: '', missing: true, ref: '', numeric: false };
			}
			return { key, authors: this.shortAuthors(e, star), year: this.year(e), missing: false, ref: plainText(this.reference(e)), numeric: false };
		});
		const refOf = new Map(parts.map((p) => [p.key, p.ref]));
		const link = (key: string, text: string, missing: boolean) =>
			missing
				? `<span class="tex-cite-missing">${text}</span>`
				: `<a class="tex-ref tex-cite" href="#tex-ref-${slug(key)}" aria-label="${escapeHtml(refOf.get(key) ?? '')}">${text}</a>`;
		const preS = pre ? pre + ' ' : '';
		const postS = post ? ', ' + post : '';
		// Numbered \bibitem entries (no author-year label) cite as [n].
		if (parts.every((p) => p.numeric)) return '[' + preS + parts.map((p) => link(p.key, p.authors.slice(1, -1), false)).join(', ') + postS + ']';
		switch (mode) {
			case 't':
				return parts
					.map((p, k) => link(p.key, p.missing ? `[${p.authors}]` : `${p.authors} (${k === 0 ? preS : ''}${p.year}${k === parts.length - 1 ? postS : ''})`, p.missing))
					.join('; ');
			case 'alt':
			case 'alp': {
				const sep = mode === 'alp' ? ', ' : ' ';
				return preS + parts.map((p) => link(p.key, p.missing ? p.authors : `${p.authors}${sep}${p.year}`, p.missing)).join('; ') + postS;
			}
			case 'author':
				return parts.map((p) => link(p.key, p.authors, p.missing)).join('; ');
			case 'year':
				return parts.map((p) => link(p.key, p.year || p.authors, p.missing)).join('; ');
			case 'yearpar':
				return '(' + preS + parts.map((p) => link(p.key, p.year || p.authors, p.missing)).join('; ') + postS + ')';
			default:
				return '(' + preS + parts.map((p) => link(p.key, p.missing ? p.authors : `${p.authors}, ${p.year}`, p.missing)).join('; ') + postS + ')';
		}
	}

	bibText(raw: string): string {
		return this.inline(parse(raw));
	}

	lastNames(e: BibEntry): string[] {
		const field = e.fields.author ?? e.fields.editor ?? '';
		return splitNames(field).map((n) => (n === 'others' ? 'others' : this.bibText(parseName(n).last)));
	}

	shortAuthors(e: BibEntry, all = false): string {
		const names = this.lastNames(e);
		if (!names.length) return this.bibText(e.fields.title ?? e.key);
		const etal = names.includes('others');
		const real = names.filter((n) => n !== 'others');
		if (all && real.length > 1) return real.slice(0, -1).join(', ') + ', and ' + real[real.length - 1];
		if (real.length === 1) return real[0]! + (etal ? ' et al.' : '');
		if (real.length === 2 && !etal) return `${real[0]} and ${real[1]}`;
		return `${real[0]} et al.`;
	}

	year(e: BibEntry): string {
		const y = e.fields.year ?? e.fields.date ?? '';
		const m = /\d{4}/.exec(y);
		return m ? m[0] : y ? this.bibText(y) : 'n.d.';
	}

	fullAuthors(e: BibEntry): string {
		const field = e.fields.author ?? e.fields.editor ?? '';
		const names = splitNames(field).map((n) => {
			if (n === 'others') return 'et al.';
			const p = parseName(n);
			const last = this.bibText(p.last);
			const first = this.bibText(p.first).replace(/\\(.)/g, '$1');
			const initials = first
				.split(/\s+/)
				.filter(Boolean)
				.map((w) => w.split('-').map((x) => (x[0] ? x[0] + '.' : '')).join('-'))
				.join(' ');
			return initials ? `${last}, ${escapeMd(initials)}` : last;
		});
		if (names.length <= 1) return names.join('');
		return names.slice(0, -1).join(', ') + ', & ' + names[names.length - 1];
	}

	// Collects \bibitem entries from any thebibliography environment in the document.
	scanBibItems(nodes: Node[]) {
		for (const node of nodes) {
			if (node.t === 'group') this.scanBibItems(node.c);
			else if (node.t === 'env' && node.name !== 'thebibliography') this.scanBibItems(node.c);
			else if (node.t === 'env') {
				for (const item of splitBibItems(node.c)) {
					// natbib labels look like "Ho et al.(2022)" or "{Abel(2022)}".
					const label = rawText(item.label).replace(/[{}]/g, '').replace(/\\natexlab\s*/g, '').trim();
					const m = /^(.*?)\s*\(([^()]*)\)/.exec(label);
					this.bibItems.set(item.key, {
						n: this.bibItems.size + 1,
						authors: m ? this.inline(parse(m[1]!)) : '',
						year: m ? escapeMd(m[2]!) : '',
						body: item.body,
					});
				}
			}
		}
	}

	thebibliography(nodes: Node[]): string {
		this.bibEmitted = true;
		const lines = splitBibItems(nodes).map((item) => {
			const entry = this.bibItems.get(item.key);
			const num = entry && !entry.year ? `[${entry.n}] ` : '';
			return `- <span class="tex-anchor" id="tex-ref-${slug(item.key)}"></span>${num}${this.inline(item.body)}`;
		});
		return `## References <span class="tex-anchor" id="tex-references"></span>\n\n${lines.join('\n')}`;
	}

	// The reference list is filled in after the whole document is converted, so
	// it also contains citations that appear after \bibliography (appendices).
	emitBibliography(out: Out) {
		if (this.bibEmitted) return;
		this.bibEmitted = true;
		out.block(BIB_PLACEHOLDER);
	}

	reference(e: BibEntry): string {
		const f = e.fields;
		let s = `${this.fullAuthors(e) || escapeMd(e.key)} (${this.year(e)}). `;
		if (f.title) s += `${this.bibText(f.title).replace(/\.$/, '')}. `;
		const venue = f.journal ?? f.journaltitle ?? f.booktitle ?? (f.eprint ? `arXiv:${f.eprint}` : null) ?? f.howpublished ?? f.school ?? f.institution ?? f.publisher;
		if (venue) {
			s += `<em>${this.bibText(venue)}</em>`;
			if (f.volume) s += `, ${this.bibText(f.volume)}`;
			if (f.number) s += `(${this.bibText(f.number)})`;
			if (f.pages) s += `, ${this.bibText(f.pages)}`;
			s += '. ';
		}
		if (f.doi) {
			const doi = `https://doi.org/${f.doi.replace(/^https?:\/\/(dx\.)?doi.org\//, '')}`;
			s += linkMd(escapeMd(doi), doi);
		} else if (f.url) s += linkMd(escapeMd(f.url), f.url);
		return s.trim();
	}

	bibliographyMarkdown(): string {
		if (!this.cited.length) return '';
		const entries = this.cited.map((k) => ({ key: k, e: this.bib.get(k) }));
		entries.sort((a, b) => {
			const ka = a.e ? (this.lastNames(a.e)[0] ?? '') + this.year(a.e) : a.key;
			const kb = b.e ? (this.lastNames(b.e)[0] ?? '') + this.year(b.e) : b.key;
			return ka.localeCompare(kb);
		});
		const lines = entries.map(({ key, e }) => {
			const anchor = `<span class="tex-anchor" id="tex-ref-${slug(key)}"></span>`;
			if (!e) return `- ${anchor}<span class="tex-cite-missing">${escapeMd(key)}</span> (not found in bibliography)`;
			return `- ${anchor}${this.reference(e)}`;
		});
		return `## References <span class="tex-anchor" id="tex-references"></span>\n\n${lines.join('\n')}`;
	}

	// Replaces reference and bibliography placeholders once all labels are known.
	finish(md: string): string {
		return md
			.replace(BIB_PLACEHOLDER, () => this.bibliographyMarkdown())
			.replace(REF_RE, (_m, kind: string, labelsRaw: string) => this.resolveRef(kind, labelsRaw));
	}
}

const BIB_PLACEHOLDER = '\uE000bibliography\uE001\uE002';

// Splits the body of a thebibliography environment at \bibitem commands.
function splitBibItems(nodes: Node[]): { key: string; label: Node[] | null; body: Node[] }[] {
	const cur = new Cursor(nodes);
	cur.arg(); // widest-label argument, e.g. {99}
	const items: { key: string; label: Node[] | null; body: Node[] }[] = [];
	while (!cur.done()) {
		const n = cur.next();
		if (n.t === 'cmd' && n.name === 'bibitem') {
			const label = cur.opt();
			items.push({ key: rawText(cur.arg()).trim(), label, body: [] });
		} else if (items.length) items[items.length - 1]!.body.push(n);
	}
	return items;
}

function plainText(md: string): string {
	return md
		.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/\\(.)/g, '$1')
		.replace(/<[^>]*>/g, '')
		.replace(/\s+/g, ' ')
		.trim();
}

export interface BlocksResult {
	head: string; // title block rendered before the first body block (no \maketitle)
	blocks: string[]; // markdown per source block, in order
	tail: string; // reference list when the source has no \bibliography
	diagnostics: Diagnostics;
}

// Converts a document block by block (for live preview). Numbering, labels and
// citations are shared across blocks exactly as in a full conversion.
export function convertBlocks(rawPreamble: string, rawBlocks: string[], opts: ConvertOptions = {}): BlocksResult {
	const macros = collectMacros(rawPreamble + '\n' + rawBlocks.join('\n\n'));
	const preamble = expandMacros(rawPreamble, macros);
	const blocks = rawBlocks.map((b) => expandMacros(b, macros));
	const c = new Converter({ ...opts, inlineFootnotes: true });
	const all = preamble + '\n' + blocks.join('\n\n');
	c.hasChapters = /\\chapter\*?\s*[{[]/.test(stripComments(all));
	c.usesBiblatex = /\\(addbibresource|printbibliography)\b/.test(stripComments(all));
	c.scanPreamble(parse(preamble));
	c.tikzHead = tikzPreamble(preamble);
	c.scanBibItems(parse(blocks.join('\n\n')));
	const headOut = new Out();
	if (c.title && !/\\maketitle\b/.test(stripComments(blocks.join('\n')))) c.emitTitle(headOut);
	const mds = blocks.map((b) => {
		const out = new Out();
		c.walk(parse(b), out);
		return out.done().join('\n\n');
	});
	const tail = !c.bibEmitted && c.cited.length ? BIB_PLACEHOLDER : '';
	return {
		head: c.finish(headOut.done().join('\n\n')),
		blocks: mds.map((m) => c.finish(m)),
		tail: c.finish(tail),
		diagnostics: c.diag,
	};
}

const preambleOnly = new Set(['documentclass', 'usepackage']);

function renderItem(marker: string, blocks: string[]): string {
	if (!blocks.length) return marker.trimEnd();
	const pad = ' '.repeat(marker.length);
	let s = '';
	blocks.forEach((b, k) => {
		const lines = b.split('\n').map((l, j) => (k === 0 && j === 0 ? marker + l : l ? pad + l : ''));
		s += (k === 0 ? '' : isListBlock(b) ? '\n' : '\n\n') + lines.join('\n');
	});
	return s;
}

// Splits an align-like body into rows on top-level `\\`.
function splitRows(b: string): string[] {
	const rows: string[] = [];
	let depth = 0;
	let envDepth = 0;
	let start = 0;
	for (let i = 0; i < b.length; i++) {
		const c = b[i];
		if (c === '\\') {
			if (b.startsWith('\\begin', i)) envDepth++;
			else if (b.startsWith('\\end', i)) envDepth--;
			else if (b[i + 1] === '\\' && depth === 0 && envDepth === 0) {
				rows.push(b.slice(start, i));
				i += 2;
				// optional spacing argument: \\[2pt]
				const m = /^\s*\[\s*-?[\d.]+\s*(pt|em|ex|mm|cm|in|bp|mu)\s*\]/.exec(b.slice(i));
				if (m) i += m[0].length;
				start = i;
				i--;
				continue;
			}
			i++;
			continue;
		}
		if (c === '{') depth++;
		else if (c === '}') depth--;
	}
	rows.push(b.slice(start));
	return rows;
}
