// Per-paragraph live preview for CodeMirror: every source block except the one
// holding the cursor is replaced by its rendered markdown.

import { ChangeDesc, EditorState, Range, StateEffect, StateField } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, WidgetType } from '@codemirror/view';
import { Component } from 'obsidian';

export interface Span {
	from: number;
	to: number;
}

export interface LiveData {
	preamble: Span | null;
	end: Span | null;
	blocks: (Span & { md: string })[];
	head: string;
	tail: string;
}

export interface LiveHost {
	compute(text: string): Promise<LiveData>;
	renderInto(el: HTMLElement, md: string, component: Component): Promise<void>;
	// Plain click on a link inside a rendered block. Returns true if handled.
	followLink(view: EditorView, a: HTMLAnchorElement): boolean;
}

const setData = StateEffect.define<LiveData>();
export const refreshLive = StateEffect.define<null>();

const heightCache = new Map<string, number>();
const components = new WeakMap<HTMLElement, Component>();

function mapSpan<T extends Span>(s: T, ch: ChangeDesc): T {
	return { ...s, from: ch.mapPos(s.from, -1), to: ch.mapPos(s.to, 1) };
}

function mapData(d: LiveData, ch: ChangeDesc): LiveData {
	return {
		...d,
		preamble: d.preamble && mapSpan(d.preamble, ch),
		end: d.end && mapSpan(d.end, ch),
		blocks: d.blocks.map((b) => mapSpan(b, ch)),
	};
}

class RenderedWidget extends WidgetType {
	constructor(
		readonly md: string,
		readonly host: LiveHost,
		readonly cls: string,
	) {
		super();
	}

	eq(other: RenderedWidget) {
		return other.md === this.md && other.cls === this.cls;
	}

	get estimatedHeight() {
		return heightCache.get(this.md) ?? Math.max(28, Math.ceil(this.md.length / 90) * 28);
	}

	toDOM(view: EditorView): HTMLElement {
		const el = createDiv({ cls: `tex-lp-block markdown-rendered ${this.cls}` });
		const comp = new Component();
		comp.load();
		components.set(el, comp);
		void this.host.renderInto(el, this.md, comp).then(() => {
			heightCache.set(this.md, el.offsetHeight);
			view.requestMeasure();
		});
		el.addEventListener('mousedown', (evt) => onWidgetMouseDown(view, el, evt, this.host));
		return el;
	}

	destroy(el: HTMLElement) {
		components.get(el)?.unload();
	}

	ignoreEvent() {
		return true;
	}
}

class PreambleWidget extends WidgetType {
	constructor(readonly lines: number) {
		super();
	}
	eq(other: PreambleWidget) {
		return other.lines === this.lines;
	}
	toDOM(view: EditorView): HTMLElement {
		const el = createDiv({ cls: 'tex-lp-preamble', text: `Preamble · ${this.lines} lines` });
		el.addEventListener('mousedown', (evt) => {
			evt.preventDefault();
			view.dispatch({ selection: { anchor: view.posAtDOM(el) } });
			view.focus();
		});
		return el;
	}
	ignoreEvent() {
		return true;
	}
}

function lineDecos(state: EditorState, s: Span, cls: string, out: Range<Decoration>[]) {
	const deco = Decoration.line({ class: cls });
	const doc = state.doc;
	const end = Math.min(s.to, doc.length);
	for (let pos = Math.max(0, s.from); pos <= end; ) {
		const line = doc.lineAt(pos);
		out.push(deco.range(line.from));
		pos = line.to + 1;
	}
}

function build(data: LiveData | null, state: EditorState, host: LiveHost): DecorationSet {
	if (!data) return Decoration.none;
	const doc = state.doc;
	const ranges = state.selection.ranges;
	const active = (s: Span) => ranges.some((r) => r.from <= s.to && r.to >= s.from);
	const out: Range<Decoration>[] = [];
	const snap = (s: Span): Span | null => {
		const from = Math.max(0, Math.min(s.from, doc.length));
		const to = Math.max(0, Math.min(s.to, doc.length));
		if (to <= from) return null;
		return { from: doc.lineAt(from).from, to: doc.lineAt(to).to };
	};

	const pre = data.preamble && snap(data.preamble);
	if (pre) {
		if (active(pre)) lineDecos(state, pre, 'tex-lp-muted', out);
		else {
			const lines = doc.lineAt(pre.to).number - doc.lineAt(pre.from).number + 1;
			out.push(Decoration.replace({ widget: new PreambleWidget(lines), block: true }).range(pre.from, pre.to));
		}
	}
	const firstBlock = data.blocks[0];
	if (data.head && firstBlock) {
		const at = Math.min(firstBlock.from, doc.length);
		out.push(Decoration.widget({ widget: new RenderedWidget(data.head, host, 'tex-lp-head'), block: true, side: -1 }).range(doc.lineAt(at).from));
	}
	for (const b of data.blocks) {
		const s = snap(b);
		if (!s) continue;
		if (!b.md.trim()) lineDecos(state, s, 'tex-lp-muted', out);
		else if (active(s)) lineDecos(state, s, 'tex-lp-source', out);
		else out.push(Decoration.replace({ widget: new RenderedWidget(b.md, host, ''), block: true }).range(s.from, s.to));
	}
	const end = data.end && snap(data.end);
	if (end) lineDecos(state, end, 'tex-lp-muted', out);
	if (data.tail) {
		const at = end ? end.from : doc.length;
		out.push(Decoration.widget({ widget: new RenderedWidget(data.tail, host, 'tex-lp-tail'), block: true, side: end ? -1 : 1 }).range(at));
	}
	return Decoration.set(out, true);
}

// Clicking a rendered block puts the cursor near the clicked word in the source.
function onWidgetMouseDown(view: EditorView, el: HTMLElement, evt: MouseEvent, host: LiveHost) {
	if (evt.button !== 0) return;
	const a = (evt.target as HTMLElement).closest('a');
	if (a && !evt.altKey && host.followLink(view, a)) {
		evt.preventDefault();
		return;
	}
	evt.preventDefault();
	const from = view.posAtDOM(el);
	const data = view.state.field(liveField).data;
	const block = data?.blocks.find((b) => b.from === from) ?? data?.blocks.find((b) => b.from <= from && b.to >= from);
	let pos = from;
	if (block) pos = block.from + guessOffset(el, evt, view.state.sliceDoc(block.from, block.to));
	view.dispatch({ selection: { anchor: Math.min(pos, view.state.doc.length) } });
	view.focus();
}

function guessOffset(el: HTMLElement, evt: MouseEvent, src: string): number {
	const caret = document.caretRangeFromPoint?.(evt.clientX, evt.clientY);
	const node = caret?.startContainer;
	if (!caret || !node || node.nodeType !== Node.TEXT_NODE || !el.contains(node) || (node.parentElement?.closest('mjx-container') ?? null)) {
		const rect = el.getBoundingClientRect();
		const ratio = rect.height ? (evt.clientY - rect.top) / rect.height : 0;
		const approx = Math.round(Math.max(0, Math.min(1, ratio)) * src.length);
		const nl = src.lastIndexOf('\n', approx);
		return nl < 0 ? 0 : nl + 1;
	}
	const text = (node as Text).data;
	const off = caret.startOffset;
	let s = off;
	let e = off;
	while (s > 0 && /[\p{L}\p{N}]/u.test(text[s - 1]!)) s--;
	while (e < text.length && /[\p{L}\p{N}]/u.test(text[e]!)) e++;
	const word = text.slice(s, e);
	if (word.length < 2) return 0;
	// How many times does the word occur in the rendered block before the click?
	let before = 0;
	const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
	const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(word)}(?![\\p{L}\\p{N}])`, 'gu');
	for (let n = walker.nextNode(); n; n = walker.nextNode()) {
		if (n.parentElement?.closest('mjx-container')) continue;
		const t = n === node ? (n as Text).data.slice(0, s) : (n as Text).data;
		before += (t.match(re) ?? []).length;
		if (n === node) break;
	}
	// Find the same occurrence in the source, skipping command names like \section.
	const srcRe = new RegExp(`(?<![\\p{L}\\p{N}\\\\])${escapeRe(word)}(?![\\p{L}\\p{N}])`, 'gu');
	let k = 0;
	let first = -1;
	for (const m of src.matchAll(srcRe)) {
		if (first < 0) first = m.index!;
		if (k === before) return m.index! + (off - s);
		k++;
	}
	return first >= 0 ? first + (off - s) : 0;
}

function escapeRe(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const liveField = StateField.define<{ data: LiveData | null; deco: DecorationSet; host: LiveHost | null }>({
	create: () => ({ data: null, deco: Decoration.none, host: null }),
	update(v, tr) {
		let data = v.data;
		let changed = false;
		for (const e of tr.effects) {
			if (e.is(setData)) {
				data = e.value;
				changed = true;
			}
		}
		if (!changed && tr.docChanged && data) data = mapData(data, tr.changes);
		if (!v.host) return v;
		if (changed || tr.docChanged || tr.selection) return { data, deco: build(data, tr.state, v.host), host: v.host };
		return v;
	},
	provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
});

export function liveData(state: EditorState): LiveData | null {
	return state.field(liveField, false)?.data ?? null;
}

export function livePreview(host: LiveHost) {
	const driver = ViewPlugin.fromClass(
		class {
			timer: number | null = null;
			gen = 0;
			constructor(readonly view: EditorView) {
				this.schedule(0);
			}
			update(u: ViewUpdate) {
				if (u.docChanged) {
					this.gen++;
					this.schedule(350);
				} else if (u.transactions.some((t) => t.effects.some((e) => e.is(refreshLive)))) this.schedule(0);
			}
			schedule(delay: number) {
				if (this.timer !== null) window.clearTimeout(this.timer);
				this.timer = window.setTimeout(() => void this.run(), delay);
			}
			async run() {
				this.timer = null;
				const gen = this.gen;
				const data = await host.compute(this.view.state.doc.toString());
				if (gen !== this.gen) return; // document changed meanwhile; a new run is scheduled
				this.view.dispatch({ effects: setData.of(data) });
			}
			destroy() {
				if (this.timer !== null) window.clearTimeout(this.timer);
			}
		},
	);
	return [liveField.init(() => ({ data: null, deco: Decoration.none, host })), driver];
}
