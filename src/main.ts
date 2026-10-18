import { loadPdfJs, Notice, Plugin, TAbstractFile, TFile, TFolder } from 'obsidian';
import { BibEntry, parseBib } from './tex/bib';
import { TexView, VIEW_TYPE_TEX } from './view';
import { DEFAULT_SETTINGS, TexViewSettings, TexViewSettingTab } from './settings';
import { createTexDocument } from './newdoc';
import { OutlineBridge } from './outline';

// The parts of Obsidian's bundled pdf.js that are used here (loadPdfJs is untyped).
interface PdfViewport {
	width: number;
	height: number;
}
interface PdfPage {
	getViewport(opts: { scale: number }): PdfViewport;
	render(opts: { canvasContext: CanvasRenderingContext2D; viewport: PdfViewport }): { promise: Promise<void> };
}
interface PdfDocument {
	getPage(n: number): Promise<PdfPage>;
	destroy(): Promise<void>;
}
interface PdfJs {
	getDocument(src: { data: Uint8Array }): { promise: Promise<PdfDocument> };
}

export default class TexViewPlugin extends Plugin {
	settings: TexViewSettings = { ...DEFAULT_SETTINGS };
	outline: OutlineBridge | null = null;
	private bibCache = new Map<string, { mtime: number; entries: Map<string, BibEntry> }>();
	private pdfCache = new Map<string, { mtime: number; url: string }>();

	async onload() {
		await this.loadSettings();
		this.registerView(VIEW_TYPE_TEX, (leaf) => new TexView(leaf, this));
		try {
			this.registerExtensions(['tex'], VIEW_TYPE_TEX);
		} catch (e) {
			// Only one plugin can open a file extension (e.g. LaTeX Live or LaTeX Studio).
			console.error('LaTeX Notes: could not register .tex files', e);
			new Notice('LaTeX Notes: another plugin already opens .tex files. Disable it and reload LaTeX Notes to use it.', 10000);
		}
		this.addSettingTab(new TexViewSettingTab(this.app, this));
		this.outline = new OutlineBridge(this);

		this.addCommand({
			id: 'new-document',
			name: 'Create new LaTeX document',
			callback: () => void createTexDocument(this),
		});
		this.registerEvent(
			this.app.workspace.on('file-menu', (menu, file) => {
				if (!(file instanceof TFolder)) return;
				menu.addItem((item) =>
					item
						.setTitle('New LaTeX document')
						.setIcon('sigma')
						.onClick(() => void createTexDocument(this, file)),
				);
			}),
		);

		this.addCommand({
			id: 'toggle-source',
			name: 'Toggle source mode',
			checkCallback: (checking) => {
				const view = this.app.workspace.getActiveViewOfType(TexView);
				if (!view) return false;
				if (!checking) view.toggleSource();
				return true;
			},
		});
		this.addCommand({
			id: 'toggle-reading',
			name: 'Toggle reading view',
			checkCallback: (checking) => {
				const view = this.app.workspace.getActiveViewOfType(TexView);
				if (!view) return false;
				if (!checking) view.toggleReading();
				return true;
			},
		});
		this.addCommand({
			id: 'conversion-report',
			name: 'Show conversion report',
			checkCallback: (checking) => {
				const view = this.app.workspace.getActiveViewOfType(TexView);
				if (!view) return false;
				if (!checking) view.showReport();
				return true;
			},
		});

		const onChange = (file: TAbstractFile) => {
			this.bibCache.delete(file.path);
			this.pdfCache.delete(file.path);
			for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_TEX)) {
				const view = leaf.view;
				if (view instanceof TexView && file instanceof TFile) view.onVaultChange(file);
			}
		};
		this.registerEvent(this.app.vault.on('modify', onChange));
		this.registerEvent(this.app.vault.on('create', onChange));
		this.registerEvent(this.app.vault.on('delete', onChange));
		this.registerEvent(this.app.vault.on('rename', (file) => onChange(file)));
	}

	async loadSettings() {
		this.settings = { ...DEFAULT_SETTINGS, ...((await this.loadData()) as Partial<TexViewSettings> | null) };
	}

	async saveSettings() {
		await this.saveData(this.settings);
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_TEX)) {
			if (leaf.view instanceof TexView) leaf.view.applyDisplaySettings();
		}
	}

	onunload() {
		this.bibCache.clear();
		this.pdfCache.clear();
	}

	async loadBib(file: TFile): Promise<Map<string, BibEntry>> {
		const cached = this.bibCache.get(file.path);
		if (cached && cached.mtime === file.stat.mtime) return cached.entries;
		const entries = parseBib(await this.app.vault.cachedRead(file));
		this.bibCache.set(file.path, { mtime: file.stat.mtime, entries });
		return entries;
	}

	// Renders the first page of a PDF to a PNG data URL with Obsidian's bundled pdf.js.
	async pdfToImage(path: string): Promise<string | null> {
		const file = this.app.vault.getFileByPath(path);
		if (!file) return null;
		const cached = this.pdfCache.get(path);
		if (cached && cached.mtime === file.stat.mtime) return cached.url;
		try {
			const pdfjs = (await loadPdfJs()) as PdfJs;
			const data = await this.app.vault.readBinary(file);
			const doc = await pdfjs.getDocument({ data: new Uint8Array(data) }).promise;
			try {
				const page = await doc.getPage(1);
				const viewport = page.getViewport({ scale: 2 });
				const canvas = createEl('canvas');
				canvas.width = Math.ceil(viewport.width);
				canvas.height = Math.ceil(viewport.height);
				const ctx = canvas.getContext('2d');
				if (!ctx) return null;
				await page.render({ canvasContext: ctx, viewport }).promise;
				const url = canvas.toDataURL('image/png');
				canvas.width = canvas.height = 0;
				this.pdfCache.set(path, { mtime: file.stat.mtime, url });
				return url;
			} finally {
				void doc.destroy();
			}
		} catch (e) {
			console.error('LaTeX Notes: could not render PDF figure', path, e);
			return null;
		}
	}
}
