import { apiVersion, Component, HeadingCache, Keymap, MarkdownRenderer, Modal, normalizePath, Notice, setIcon, Setting, setTooltip, TextFileView, TFile, ViewStateResult, WorkspaceLeaf } from 'obsidian';
import { Annotation, Compartment, EditorState } from '@codemirror/state';
import { drawSelection, EditorView, keymap } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { search, searchKeymap } from '@codemirror/search';
import { bracketMatching, StreamLanguage } from '@codemirror/language';
import { stex } from '@codemirror/legacy-modes/mode/stex';
import { convert, convertBlocks, ConvertOptions, Diagnostics } from './tex/convert';
import { BibEntry } from './tex/bib';
import { expandIncludes, findBibFiles } from './tex/project';
import { segment } from './tex/blocks';
import { LiveData, LiveHost, livePreview, liveData, refreshLive } from './live';
import { texHighlighter } from './highlight';
import { scanHeadings } from './tex/headings';
import type TexViewPlugin from './main';

export const VIEW_TYPE_TEX = 'latex-notes';

const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'pdf'];

type Mode = 'live' | 'source' | 'reading';

const external = Annotation.define<boolean>();

interface Context {
	opts: ConvertOptions;
	read: (rel: string) => Promise<string | null>;
	deps: Set<string>;
}

export class TexView extends TextFileView implements LiveHost {
	mode: Mode = 'live';
	deps = new Set<string>(); // vault paths the current rendering depends on
	diagnostics: Diagnostics | null = null;
	mathErrors = 0;
	editor: EditorView | null = null;
	private lastSynced = '';
	private liveCompartment = new Compartment();
	private editorHost: HTMLElement;
	private readingHost: HTMLElement;
	private readingChild: Component | null = null;
	private readingToken = 0;
	private readingBusy = false;
	private pendingReadingLine: number | null = null;
	private readingTimer: number | null = null;
	private modeAction: HTMLElement;
	private sourceAction: HTMLElement;

	constructor(leaf: WorkspaceLeaf, private plugin: TexViewPlugin) {
		super(leaf);
		this.addAction('info', 'Conversion report', () => this.showReport());
		this.sourceAction = this.addAction('code', 'Source mode', () => this.setMode(this.mode === 'source' ? 'live' : 'source'));
		this.modeAction = this.addAction('book-open', 'Reading view', () => this.setMode(this.mode === 'reading' ? 'live' : 'reading'));
		this.contentEl.addClass('tex-view-content');
		this.editorHost = this.contentEl.createDiv({ cls: 'tex-editor-host' });
		this.readingHost = this.contentEl.createDiv({ cls: 'markdown-preview-view markdown-rendered tex-view' });
		this.registerDomEvent(this.readingHost, 'scroll', () => this.scheduleOutlineHighlight());
	}

	getViewType() {
		return VIEW_TYPE_TEX;
	}

	getIcon() {
		return 'sigma';
	}

	getDisplayText() {
		return this.file?.basename ?? 'LaTeX';
	}

	canAcceptExtension(extension: string) {
		return extension === 'tex';
	}

	getState(): Record<string, unknown> {
		return { ...super.getState(), texMode: this.mode };
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		const mode = (state as { texMode?: Mode } | null)?.texMode;
		if (mode === 'live' || mode === 'source' || mode === 'reading') this.mode = mode;
		await super.setState(state, result);
		this.applyMode();
	}

	// --- TextFileView ---------------------------------------------------------

	getViewData(): string {
		return this.editor ? this.editor.state.doc.toString() : this.data;
	}

	setViewData(data: string, clear: boolean): void {
		this.data = data;
		this.lastSynced = data;
		if (!this.editor) {
			this.editor = new EditorView({ state: this.makeState(data), parent: this.editorHost });
		} else if (clear) {
			this.editor.setState(this.makeState(data));
		} else if (data !== this.editor.state.doc.toString()) {
			this.editor.dispatch({ changes: { from: 0, to: this.editor.state.doc.length, insert: data }, annotations: external.of(true) });
		}
		this.applyMode();
		if (this.pendingLine !== null) {
			const line = this.pendingLine;
			this.pendingLine = null;
			this.scrollToLine(line);
		}
		this.plugin.outline?.refresh(this.file);
	}

	clear(): void {
		this.editor?.setState(this.makeState(''));
		this.readingHost.empty();
		this.deps.clear();
	}

	async save(clear?: boolean): Promise<void> {
		await super.save(clear);
		this.lastSynced = this.data;
	}

	async onClose() {
		this.editor?.destroy();
		this.editor = null;
		this.readingChild?.unload();
	}

	private makeState(doc: string): EditorState {
		// Start with the cursor at the beginning of the body, so the preamble is collapsed.
		const begin = /\\begin\s*\{document\}[^\n]*\n?/.exec(doc);
		const anchor = begin ? begin.index + begin[0].length : 0;
		return EditorState.create({
			doc,
			selection: { anchor: Math.min(anchor, doc.length) },
			extensions: [
				history(),
				drawSelection(),
				EditorView.lineWrapping,
				bracketMatching(),
				search({ top: true }),
				StreamLanguage.define(stex), // comment syntax for toggle-comment
				texHighlighter,
				keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
				this.liveCompartment.of(this.mode === 'live' ? livePreview(this) : []),
				EditorView.updateListener.of((u) => {
					if (u.docChanged) this.scheduleOutlineRefresh();
					else if (u.selectionSet) this.scheduleOutlineHighlight();
					if (!u.docChanged || u.transactions.every((t) => t.annotation(external))) return;
					this.requestSave();
				}),
			],
		});
	}

	// --- outline ----------------------------------------------------------------

	private headingCache: { text: string; headings: HeadingCache[] } | null = null;
	private pendingLine: number | null = null;
	private outlineTimer: number | null = null;
	private highlightFrame: number | null = null;

	// Headings in the shape of Obsidian's metadata cache, for the core Outline.
	outlineHeadings(): HeadingCache[] {
		const text = this.getViewData();
		if (this.headingCache?.text === text) return this.headingCache.headings;
		const headings = scanHeadings(text).map((h) => ({
			heading: h.text,
			level: h.level,
			position: { start: { line: h.line, col: 0, offset: h.from }, end: { line: h.line, col: 0, offset: h.to } },
		}));
		this.headingCache = { text, headings };
		return headings;
	}

	// The outline item for the section the cursor (or reading scroll position) is in.
	activeOutlineItem<T extends { heading: HeadingCache }>(items: T[]): T | null {
		let line = -1;
		if (this.mode === 'reading') {
			const top = this.readingHost.getBoundingClientRect().top + 80;
			const rendered = Array.from(this.readingHost.querySelectorAll<HTMLElement>('h2, h3, h4, h5, h6'));
			let current: HTMLElement | null = null;
			for (const el of rendered) if (el.getBoundingClientRect().top <= top) current = el;
			if (current) {
				const text = current.textContent?.trim() ?? '';
				const match = items.find((it) => text === it.heading.heading || text.startsWith(it.heading.heading));
				if (match) return match;
			}
			return null;
		}
		if (!this.editor) return null;
		line = this.editor.state.doc.lineAt(this.editor.state.selection.main.head).number - 1;
		let best: T | null = null;
		for (const it of items) if (it.heading.position.start.line <= line) best = it;
		return best;
	}

	// Called by the Outline (and when opening a link with a line) to jump to a line.
	setEphemeralState(state: unknown): void {
		super.setEphemeralState(state);
		const line = (state as { line?: unknown } | null)?.line;
		if (typeof line !== 'number') return;
		if (!this.editor) this.pendingLine = line;
		else this.scrollToLine(line);
	}

	private scrollToLine(line: number) {
		if (this.mode === 'reading') {
			// A render in progress would restore the old scroll position afterwards.
			if (this.readingBusy) {
				this.pendingReadingLine = line;
				return;
			}
			const h = this.outlineHeadings().find((x) => x.position.start.line === line);
			if (!h) return;
			const el = Array.from(this.readingHost.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6')).find((e) => (e.textContent?.trim() ?? '').startsWith(h.heading));
			el?.scrollIntoView({ block: 'start' });
			return;
		}
		const ed = this.editor;
		if (!ed) return;
		const pos = ed.state.doc.line(Math.min(line + 1, ed.state.doc.lines)).from;
		ed.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'start', yMargin: 40 }) });
		ed.focus();
	}

	private scheduleOutlineRefresh() {
		if (this.outlineTimer !== null) window.clearTimeout(this.outlineTimer);
		this.outlineTimer = window.setTimeout(() => {
			this.outlineTimer = null;
			this.plugin.outline?.refresh(this.file);
		}, 500);
	}

	private scheduleOutlineHighlight() {
		if (this.highlightFrame !== null) return;
		this.highlightFrame = window.requestAnimationFrame(() => {
			this.highlightFrame = null;
			this.plugin.outline?.highlight(this);
		});
	}

	// Called by the plugin for any vault change.
	onVaultChange(file: TFile) {
		if (file.path === this.file?.path) {
			void this.reloadIfChangedOnDisk(file);
			return;
		}
		if (!this.deps.has(file.path)) return;
		if (this.mode === 'reading') this.scheduleReading();
		else if (this.mode === 'live') this.editor?.dispatch({ effects: refreshLive.of(null) });
	}

	private async reloadIfChangedOnDisk(file: TFile) {
		let content: string;
		try {
			content = await this.app.vault.read(file);
		} catch {
			return; // deleted or unreadable
		}
		const current = this.getViewData();
		if (content === current) return;
		// Only take the disk version if there are no unsaved edits here.
		if (current === this.lastSynced) this.setViewData(content, false);
	}

	// --- modes ----------------------------------------------------------------

	setMode(mode: Mode) {
		this.mode = mode;
		this.applyMode();
		this.app.workspace.requestSaveLayout();
	}

	toggleSource() {
		this.setMode(this.mode === 'source' ? 'live' : 'source');
	}

	toggleReading() {
		this.setMode(this.mode === 'reading' ? 'live' : 'reading');
	}

	applyDisplaySettings() {
		const readable = this.plugin.settings.readableLineLength;
		this.editorHost.toggleClass('is-readable-line-width', readable);
		this.readingHost.toggleClass('is-readable-line-width', readable);
	}

	private applyMode() {
		const reading = this.mode === 'reading';
		this.editorHost.toggle(!reading);
		this.readingHost.toggle(reading);
		this.editorHost.toggleClass('mode-source', this.mode === 'source');
		this.editorHost.toggleClass('mode-live', this.mode === 'live');
		this.applyDisplaySettings();
		setIcon(this.modeAction, reading ? 'edit-3' : 'book-open');
		this.modeAction.setAttribute('aria-label', reading ? 'Edit' : 'Reading view');
		this.sourceAction.toggle(!reading);
		this.sourceAction.toggleClass('is-active', this.mode === 'source');
		this.sourceAction.setAttribute('aria-label', this.mode === 'source' ? 'Live preview' : 'Source mode');
		if (this.editor) {
			const want = this.mode === 'live';
			this.editor.dispatch({ effects: this.liveCompartment.reconfigure(want ? livePreview(this) : []) });
		}
		if (reading) void this.renderReading();
		else this.editor?.focus();
		this.plugin.outline?.refresh(this.file);
	}

	// --- conversion context ---------------------------------------------------

	private async context(text: string): Promise<Context> {
		const file = this.file;
		const vault = this.app.vault;
		const dir = file?.parent?.path ?? '';
		const join = (rel: string) => normalizePath(dir && dir !== '/' ? `${dir}/${rel}` : rel);
		const deps = new Set<string>(file ? [file.path] : []);
		const read = async (rel: string) => {
			const p = join(rel);
			deps.add(p);
			const f = vault.getFileByPath(p);
			return f ? vault.cachedRead(f) : null;
		};
		let bibFiles = findBibFiles(text).map(join);
		if (!bibFiles.length && /\\(cite|citep|citet|parencite|textcite)\b/.test(text)) {
			bibFiles = (file?.parent?.children ?? []).filter((f): f is TFile => f instanceof TFile && f.extension === 'bib').map((f) => f.path);
		}
		const bib = new Map<string, BibEntry>();
		for (const p of bibFiles) {
			deps.add(p);
			const f = vault.getFileByPath(p);
			if (!f) continue;
			for (const [k, v] of await this.plugin.loadBib(f)) bib.set(k, v);
		}
		const resolveAsset: ConvertOptions['resolveAsset'] = (path) => {
			const base = join(path);
			const hasExt = /\.[A-Za-z0-9]+$/.test(path);
			const candidates = hasExt ? [base, ...IMAGE_EXTS.map((e) => `${base}.${e}`)] : IMAGE_EXTS.map((e) => `${base}.${e}`);
			for (const c of candidates) {
				const f = vault.getFileByPath(c);
				if (f && IMAGE_EXTS.includes(f.extension.toLowerCase())) {
					deps.add(f.path);
					return { kind: f.extension.toLowerCase() === 'pdf' ? 'pdf' : 'image', src: vault.getResourcePath(f), path: f.path };
				}
			}
			return null;
		};
		return { opts: { bib, resolveAsset }, read, deps };
	}

	// --- live preview host ----------------------------------------------------

	async compute(text: string): Promise<LiveData> {
		const seg = segment(text);
		const ctx = await this.context(text);
		const blockTexts = await Promise.all(
			seg.blocks.map(async (b) => {
				const t = text.slice(b.from, b.to);
				return /\\(input|include|subfile)\b/.test(t) ? (await expandIncludes(t, ctx.read)).src : t;
			}),
		);
		const preamble = seg.preamble ? text.slice(seg.preamble.from, seg.preamble.to) : '';
		const res = convertBlocks(preamble, blockTexts, ctx.opts);
		this.deps = ctx.deps;
		this.diagnostics = res.diagnostics;
		return {
			preamble: seg.preamble,
			end: seg.end,
			blocks: seg.blocks.map((b, i) => ({ ...b, md: res.blocks[i] ?? '' })),
			head: res.head,
			tail: res.tail,
		};
	}

	async renderInto(el: HTMLElement, md: string, component: Component): Promise<void> {
		await MarkdownRenderer.render(this.app, md, el, this.file?.path ?? '', component);
		this.decorate(el);
	}

	followLink(view: EditorView, a: HTMLAnchorElement): boolean {
		const href = a.getAttribute('href') ?? '';
		if (href.startsWith('#')) {
			const id = href.slice(1);
			const data = liveData(view.state);
			const block = data?.blocks.find((b) => b.md.includes(`id="${id}"`));
			const target = block?.from ?? (data?.tail.includes(`id="${id}"`) ? view.state.doc.length : null);
			if (target !== null && target !== undefined) view.dispatch({ effects: EditorView.scrollIntoView(target, { y: 'center' }) });
			return true;
		}
		if (a.hasClass('internal-link')) {
			void this.app.workspace.openLinkText(a.getAttribute('data-href') ?? href, this.file?.path ?? '', false);
			return true;
		}
		if (/^https?:/.test(href)) {
			window.open(href);
			return true;
		}
		return false;
	}

	// --- reading view ---------------------------------------------------------

	private scheduleReading() {
		if (this.readingTimer !== null) window.clearTimeout(this.readingTimer);
		this.readingTimer = window.setTimeout(() => {
			this.readingTimer = null;
			void this.renderReading();
		}, 300);
	}

	async renderReading() {
		if (!this.file) return;
		const token = ++this.readingToken;
		this.readingBusy = true;
		const text = this.getViewData();
		const ctx = await this.context(text);
		const expanded = await expandIncludes(text, ctx.read);
		const result = convert(expanded.src, ctx.opts);
		if (token !== this.readingToken) return;
		this.deps = ctx.deps;
		this.diagnostics = result.diagnostics;

		const view = this.readingHost;
		const scroll = view.scrollTop;
		this.readingChild?.unload();
		const child = new Component();
		this.readingChild = child;
		this.addChild(child);
		view.empty();
		const sizer = view.createDiv({ cls: 'markdown-preview-sizer markdown-preview-section' });
		await MarkdownRenderer.render(this.app, result.markdown, sizer, this.file.path, child);
		if (token !== this.readingToken) return;
		this.decorate(sizer);
		this.readingClicks(sizer, child);
		view.scrollTop = scroll;
		this.readingBusy = false;
		if (this.pendingReadingLine !== null) {
			const line = this.pendingReadingLine;
			this.pendingReadingLine = null;
			this.scrollToLine(line);
		}
		window.setTimeout(() => {
			this.mathErrors = sizer.querySelectorAll('mjx-merror').length;
		}, 1000);
	}

	private readingClicks(el: HTMLElement, child: Component) {
		child.registerDomEvent(el, 'click', (evt: MouseEvent) => {
			const a = (evt.target as HTMLElement).closest('a');
			if (!a) return;
			const href = a.getAttribute('href') ?? '';
			if (href.startsWith('#')) {
				evt.preventDefault();
				const target = el.querySelector<HTMLElement>(`[id="${CSS.escape(href.slice(1))}"]`);
				if (!target) return;
				const block = target.closest<HTMLElement>('li, p, h1, h2, h3, h4, h5, h6, .callout, .tex-anchor') ?? target;
				const flash = block.classList.contains('tex-anchor') ? (block.nextElementSibling as HTMLElement | null) ?? block : block;
				flash.scrollIntoView({ block: 'center', behavior: 'smooth' });
				flash.addClass('tex-flash');
				window.setTimeout(() => flash.removeClass('tex-flash'), 1200);
			} else if (a.hasClass('internal-link')) {
				evt.preventDefault();
				const link = a.getAttribute('data-href') ?? href;
				void this.app.workspace.openLinkText(link, this.file?.path ?? '', Keymap.isModEvent(evt));
			}
		});
	}

	// Post-processing shared by reading view and live preview blocks.
	private decorate(el: HTMLElement) {
		el.querySelectorAll<HTMLElement>('span[class*="tex-mark-"]').forEach((span) => {
			const cls = Array.from(span.classList).find((c) => c.startsWith('tex-mark-'));
			const p = span.closest('p');
			if (cls && p) p.addClass('tex-' + cls.slice('tex-mark-'.length));
		});
		// An image alone on a line becomes a bare HTML block; give it a centred wrapper.
		el.querySelectorAll<HTMLElement>('img.tex-img, span.tex-pdf').forEach((img) => {
			const p = img.closest('p');
			if (p) p.addClass('tex-figure');
			else if (!img.parentElement?.hasClass('tex-figure')) {
				const wrap = createDiv({ cls: 'tex-figure' });
				img.replaceWith(wrap);
				wrap.appendChild(img);
			}
		});
		// Inline formulas that can't fit their paragraph (common on phones) get their own scroll box.
		window.requestAnimationFrame(() => {
			el.querySelectorAll<HTMLElement>('.math-inline mjx-container').forEach((m) => {
				const block = m.closest<HTMLElement>('p, li, td, th, .callout-content') ?? el;
				if (m.offsetWidth > block.clientWidth) m.addClass('tex-wide-math');
			});
		});
		el.querySelectorAll<HTMLElement>('.tex-cite[aria-label], .tex-fn[aria-label]').forEach((t) => {
			const label = t.getAttribute('aria-label');
			if (label) setTooltip(t, label, { delay: 300 });
		});
		el.querySelectorAll<HTMLElement>('span.tex-pdf').forEach((span) => {
			const path = span.dataset.path;
			if (!path) return;
			const img = createEl('img', { cls: 'tex-img' });
			if (span.style.width) img.setCssStyles({ width: span.style.width });
			span.replaceWith(img);
			void this.plugin.pdfToImage(path).then((url) => {
				if (url) img.src = url;
				else img.replaceWith(createSpan({ cls: 'tex-missing', text: `Could not render PDF figure: ${path}` }));
			});
		});
	}

	showReport() {
		const d = this.diagnostics;
		const modal = new Modal(this.app);
		modal.setTitle('LaTeX conversion report');
		const c = modal.contentEl;
		if (!d) {
			c.createEl('p', { text: 'No conversion yet.' });
		} else {
			const section = (title: string, items: string[]) => {
				c.createEl('h4', { text: `${title} (${items.length})` });
				if (!items.length) c.createEl('p', { text: 'None', cls: 'tex-report-none' });
				else {
					const ul = c.createEl('ul');
					for (const i of items) ul.createEl('li', { text: i });
				}
			};
			section('Unknown commands (dropped, arguments kept)', Object.entries(d.unknownCommands).map(([k, v]) => `\\${k} ×${v}`));
			section('Environments shown as raw source', Object.entries(d.rawEnvironments).map(([k, v]) => `${k} ×${v}`));
			section('Missing figures', d.missingAssets);
			section('Citations not found in .bib', d.missingCitations);
			section('Unresolved references', d.missingRefs);
			if (this.mode === 'reading') c.createEl('h4', { text: `Math errors in rendered view: ${this.mathErrors}` });
			c.createEl('p', { text: 'Dependencies watched: ' + [...this.deps].join(', '), cls: 'tex-report-deps' });
			// Plain-text version for bug reports (no file paths or document content).
			const text = [
				`LaTeX Notes ${this.plugin.manifest.version}, Obsidian ${apiVersion}, mode: ${this.mode}`,
				`Unknown commands: ${Object.entries(d.unknownCommands).map(([k, v]) => `\\${k} x${v}`).join(', ') || 'none'}`,
				`Raw environments: ${Object.entries(d.rawEnvironments).map(([k, v]) => `${k} x${v}`).join(', ') || 'none'}`,
				`Missing figures: ${d.missingAssets.length}, missing citations: ${d.missingCitations.length}, unresolved refs: ${d.missingRefs.length}`,
			].join('\n');
			new Setting(c).addButton((b) =>
				b.setButtonText('Copy report').onClick(() => {
					void navigator.clipboard.writeText(text);
					new Notice('Conversion report copied');
				}),
			);
		}
		modal.open();
	}
}
