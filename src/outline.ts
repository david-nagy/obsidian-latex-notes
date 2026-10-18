// Makes Obsidian's core Outline pane work for .tex files.
//
// The Outline only accepts markdown files and markdown views, so a few of its
// methods are wrapped. Every wrapper handles .tex files only, checks that the
// internals it relies on still exist, and falls back to the original method on
// any error. If a future Obsidian version changes these internals, the patches
// are skipped and the Outline simply shows nothing for .tex files.

import { around } from 'monkey-around';
import { HeadingCache, TFile, View, WorkspaceLeaf } from 'obsidian';
import { TexView, VIEW_TYPE_TEX } from './view';
import type TexViewPlugin from './main';

const REQUIRED = ['getHeadings', 'findCorrespondingLeaf', 'findActiveHeading', 'getOwner', 'setHighlightedItem', 'update'];

interface OutlineItem {
	heading: HeadingCache;
}

// The parts of the core Outline view we rely on (not public API).
interface OutlineView extends View {
	file: TFile | null;
	cachedHeadingDom?: OutlineItem[];
	getHeadings(): HeadingCache[];
	findCorrespondingLeaf(): WorkspaceLeaf | null;
	findActiveHeading(owner: unknown): OutlineItem | null | undefined;
	getOwner(): unknown;
	setHighlightedItem(item: OutlineItem | null | undefined): void;
	update(): void;
	requestUpdate?: () => void;
}

const isTex = (f: TFile | null | undefined) => f instanceof TFile && f.extension === 'tex';

export class OutlineBridge {
	private patched = false;
	private warned = false;

	constructor(private plugin: TexViewPlugin) {
		const app = plugin.app;
		app.workspace.onLayoutReady(() => this.tryPatch());
		plugin.registerEvent(app.workspace.on('layout-change', () => this.tryPatch()));
	}

	private outlineViews(): OutlineView[] {
		return this.plugin.app.workspace
			.getLeavesOfType('outline')
			.map((l) => l.view as unknown as OutlineView)
			.filter((v) => typeof v?.getHeadings === 'function');
	}

	private tryPatch() {
		if (this.patched) return;
		const view = this.outlineViews()[0];
		if (!view) return; // Outline not open (or not loaded yet); try again on the next layout change.
		const proto = Object.getPrototypeOf(view) as Record<string, unknown>;
		if (!REQUIRED.every((n) => typeof proto[n] === 'function')) {
			if (!this.warned) console.warn('LaTeX Notes: the Outline view has changed; .tex outlines are disabled.');
			this.warned = true;
			return;
		}
		// Bound helpers, so the wrappers below can keep the Outline's own `this`.
		const headingsFor = (f: TFile) => this.headingsFor(f);
		const texLeaf = (f: TFile, l: WorkspaceLeaf | null) => this.texLeaf(f, l);
		const uninstall = around(proto as unknown as OutlineView, {
			getHeadings(next) {
				return function (this: OutlineView) {
					try {
						if (isTex(this.file)) return headingsFor(this.file!);
					} catch (e) {
						console.error('LaTeX Notes outline:', e);
					}
					return next.call(this);
				};
			},
			findCorrespondingLeaf(next) {
				return function (this: OutlineView) {
					const leaf = next.call(this);
					if (leaf) return leaf;
					try {
						if (isTex(this.file)) return texLeaf(this.file!, this.leaf);
					} catch (e) {
						console.error('LaTeX Notes outline:', e);
					}
					return leaf;
				};
			},
			getOwner(next) {
				return function (this: OutlineView) {
					try {
						if (isTex(this.file)) {
							const leaf = texLeaf(this.file!, this.leaf);
							if (leaf) return leaf.view;
						}
					} catch (e) {
						console.error('LaTeX Notes outline:', e);
					}
					return next.call(this);
				};
			},
			findActiveHeading(next) {
				return function (this: OutlineView, owner: unknown) {
					if (owner instanceof TexView) {
						try {
							return owner.activeOutlineItem(this.cachedHeadingDom ?? []);
						} catch (e) {
							console.error('LaTeX Notes outline:', e);
							return null;
						}
					}
					return next.call(this, owner);
				};
			},
		});
		this.plugin.register(uninstall);
		this.patched = true;
		// Outlines currently showing a .tex file need a fresh look.
		for (const v of this.outlineViews()) if (isTex(v.file)) v.update();
	}

	headingsFor(file: TFile): HeadingCache[] {
		const leaf = this.texLeaf(file, null);
		return leaf ? (leaf.view as TexView).outlineHeadings() : [];
	}

	// The TeX view showing this file: one in the outline's linked group, else the
	// active one, else any.
	texLeaf(file: TFile, outlineLeaf: WorkspaceLeaf | null): WorkspaceLeaf | null {
		const ws = this.plugin.app.workspace;
		const leaves = ws.getLeavesOfType(VIEW_TYPE_TEX).filter((l) => l.view instanceof TexView && l.view.file === file);
		const group = (outlineLeaf as unknown as { group?: string } | null)?.group;
		if (group) {
			const inGroup = leaves.find((l) => (l as unknown as { group?: string }).group === group);
			if (inGroup) return inGroup;
		}
		const active = ws.getActiveViewOfType(TexView);
		return leaves.find((l) => l.view === active) ?? leaves[0] ?? null;
	}

	// Rebuild outlines showing this file (after edits).
	refresh(file: TFile | null) {
		if (!this.patched || !file) return;
		for (const v of this.outlineViews()) {
			if (v.file !== file) continue;
			try {
				if (v.requestUpdate) v.requestUpdate();
				else v.update();
			} catch (e) {
				console.error('LaTeX Notes outline:', e);
			}
		}
	}

	// Move the outline's highlight to the section the view is in.
	highlight(view: TexView) {
		if (!this.patched || !view.file) return;
		for (const v of this.outlineViews()) {
			if (v.file !== view.file) continue;
			try {
				v.setHighlightedItem(v.findActiveHeading(view));
			} catch (e) {
				console.error('LaTeX Notes outline:', e);
			}
		}
	}
}
