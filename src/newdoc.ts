import { App, Modal, moment, normalizePath, Notice, Setting, TFile, TFolder } from 'obsidian';
import { findBibFiles } from './tex/project';
import { BUILTIN_TEMPLATE } from './settings';
import { TexView } from './view';
import type TexViewPlugin from './main';

class TitleModal extends Modal {
	private title = '';
	private done = false;

	constructor(
		app: App,
		private resolve: (title: string | null) => void,
	) {
		super(app);
	}

	onOpen() {
		this.setTitle('New LaTeX document');
		const submit = () => {
			if (!this.title.trim()) return;
			this.done = true;
			this.close();
			this.resolve(this.title.trim());
		};
		new Setting(this.contentEl).setName('Title').addText((text) => {
			text.onChange((v) => (this.title = v));
			text.inputEl.addEventListener('keydown', (evt) => {
				if (evt.key === 'Enter' && !evt.isComposing) {
					evt.preventDefault();
					submit();
				}
			});
			window.setTimeout(() => text.inputEl.focus(), 0);
		});
		new Setting(this.contentEl).addButton((b) => b.setButtonText('Create').setCta().onClick(submit));
	}

	onClose() {
		this.contentEl.empty();
		if (!this.done) this.resolve(null);
	}
}

function askTitle(app: App): Promise<string | null> {
	return new Promise((resolve) => new TitleModal(app, resolve).open());
}

// Escapes characters that would break a LaTeX title.
function escapeLatex(s: string): string {
	return s.replace(/([&%$#_])/g, '\\$1');
}

async function targetFolder(plugin: TexViewPlugin, explicit?: TFolder): Promise<TFolder> {
	const { app } = plugin;
	if (explicit) return explicit;
	const configured = plugin.settings.newFileFolder.trim();
	if (configured) {
		const path = normalizePath(configured);
		const existing = app.vault.getFolderByPath(path);
		if (existing) return existing;
		await app.vault.createFolder(path);
		return app.vault.getFolderByPath(path) ?? app.vault.getRoot();
	}
	return app.fileManager.getNewFileParent(app.workspace.getActiveFile()?.path ?? '');
}

function uniquePath(app: App, folder: TFolder, name: string): string {
	const base = folder.isRoot() ? '' : `${folder.path}/`;
	let path = normalizePath(`${base}${name}.tex`);
	for (let k = 1; app.vault.getAbstractFileByPath(path); k++) path = normalizePath(`${base}${name} ${k}.tex`);
	return path;
}

async function loadTemplate(plugin: TexViewPlugin): Promise<string> {
	const path = plugin.settings.templatePath.trim();
	if (!path) return BUILTIN_TEMPLATE;
	const file = plugin.app.vault.getFileByPath(normalizePath(path));
	if (!file) {
		new Notice(`LaTeX Notes: template "${path}" not found, using the built-in template.`);
		return BUILTIN_TEMPLATE;
	}
	return plugin.app.vault.read(file);
}

export async function createTexDocument(plugin: TexViewPlugin, folder?: TFolder) {
	const { app } = plugin;
	const title = await askTitle(app);
	if (!title) return;
	const name = title.replace(/[\\/:*?"<>|#^[\]]/g, '').trim() || 'Untitled';
	const dir = await targetFolder(plugin, folder);
	const path = uniquePath(app, dir, name);

	let content = (await loadTemplate(plugin))
		.replace(/\{\{title\}\}/g, () => escapeLatex(title))
		.replace(/\{\{author\}\}/g, () => plugin.settings.author)
		.replace(/\{\{date(?::([^}]*))?\}\}/g, (_m, fmt: string | undefined) => moment().format(fmt || 'YYYY-MM-DD'));
	const cursor = content.indexOf('{{cursor}}');
	content = content.replace(/\{\{cursor\}\}/g, '');

	const file = await app.vault.create(path, content);
	if (plugin.settings.createBib) {
		for (const bib of findBibFiles(content)) {
			const bibPath = normalizePath(dir.isRoot() ? bib : `${dir.path}/${bib}`);
			if (!app.vault.getAbstractFileByPath(bibPath)) await app.vault.create(bibPath, '');
		}
	}

	const leaf = app.workspace.getLeaf(false);
	await leaf.openFile(file);
	const view = leaf.view;
	if (cursor >= 0 && view instanceof TexView && view.editor) {
		view.editor.dispatch({ selection: { anchor: Math.min(cursor, view.editor.state.doc.length) }, scrollIntoView: true });
		view.editor.focus();
	}
	return file as TFile;
}
