import { AbstractInputSuggest, App, normalizePath, PluginSettingTab, Setting, TAbstractFile, TFile, TFolder } from 'obsidian';
import type TexViewPlugin from './main';

export interface TexViewSettings {
	templatePath: string; // vault path of a .tex template; empty = built-in template
	author: string;
	newFileFolder: string; // empty = Obsidian's default location for new notes
	createBib: boolean;
}

export const DEFAULT_SETTINGS: TexViewSettings = {
	templatePath: '',
	author: '',
	newFileFolder: '',
	createBib: true,
};

// Used when no template file is set. Placeholders: {{title}}, {{author}},
// {{date}} or {{date:FORMAT}}, and {{cursor}} for where the cursor starts.
export const BUILTIN_TEMPLATE = String.raw`\documentclass[11pt]{article}
\usepackage[margin=1in]{geometry}
\usepackage{amsmath, amssymb, amsthm}
\usepackage{graphicx}
\usepackage{booktabs}
\usepackage[authoryear, round]{natbib}
\usepackage{hyperref}
% Section numbers with a trailing dot ("1. Introduction"), as LaTeX Notes shows them.
\makeatletter
\renewcommand\@seccntformat[1]{\csname the#1\endcsname.\quad}
\makeatother

\title{{{title}}}
\author{{{author}}}
\date{{{date}}}

\begin{document}

\maketitle

\begin{abstract}

\end{abstract}

\section{Introduction}

{{cursor}}

\bibliographystyle{abbrvnat}
\bibliography{references}

\end{document}
`;

class FileSuggest extends AbstractInputSuggest<TAbstractFile> {
	constructor(
		app: App,
		private input: HTMLInputElement,
		private filter: (f: TAbstractFile) => boolean,
	) {
		super(app, input);
	}
	getSuggestions(query: string): TAbstractFile[] {
		const q = query.toLowerCase();
		return this.app.vault
			.getAllLoadedFiles()
			.filter((f) => this.filter(f) && f.path.toLowerCase().includes(q))
			.slice(0, 50);
	}
	renderSuggestion(file: TAbstractFile, el: HTMLElement) {
		el.setText(file.path || '/');
	}
	selectSuggestion(file: TAbstractFile) {
		this.setValue(file.path);
		this.input.dispatchEvent(new Event('input'));
		this.close();
	}
}

export class TexViewSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private plugin: TexViewPlugin,
	) {
		super(app, plugin);
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();
		const s = this.plugin.settings;
		const save = () => void this.plugin.saveSettings();

		new Setting(containerEl).setName('New LaTeX documents').setHeading();

		const templateSetting = new Setting(containerEl)
			.setName('Template file')
			.setDesc('A .tex file used for new documents. Placeholders: {{title}}, {{author}}, {{date}} or {{date:YYYY-MM-DD}}, {{cursor}}. Leave empty for the built-in template.');
		templateSetting.addText((text) => {
			text.setPlaceholder('templates/LaTeX document.tex').setValue(s.templatePath);
			new FileSuggest(this.app, text.inputEl, (f) => f instanceof TFile && f.extension === 'tex');
			text.onChange((v) => {
				s.templatePath = normalizePath(v.trim()) === '/' ? '' : v.trim();
				const ok = !s.templatePath || this.app.vault.getFileByPath(normalizePath(s.templatePath));
				text.inputEl.toggleClass('tex-setting-invalid', !ok);
				save();
			});
		});

		new Setting(containerEl)
			.setName('Author')
			.setDesc('Fills the {{author}} placeholder.')
			.addText((text) =>
				text.setValue(s.author).onChange((v) => {
					s.author = v;
					save();
				}),
			);

		new Setting(containerEl)
			.setName('Folder for new documents')
			.setDesc("Leave empty to use Obsidian's default location for new notes.")
			.addText((text) => {
				text.setPlaceholder('Default location').setValue(s.newFileFolder);
				new FileSuggest(this.app, text.inputEl, (f) => f instanceof TFolder);
				text.onChange((v) => {
					s.newFileFolder = v.trim();
					save();
				});
			});

		new Setting(containerEl)
			.setName('Create missing .bib files')
			.setDesc('Create an empty bibliography file next to the new document when the template refers to one.')
			.addToggle((t) =>
				t.setValue(s.createBib).onChange((v) => {
					s.createBib = v;
					save();
				}),
			);
	}
}
