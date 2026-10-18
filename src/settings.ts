import { App, normalizePath, PluginSettingTab, Setting, SettingDefinitionItem } from 'obsidian';
import type TexViewPlugin from './main';

export interface TexViewSettings {
	templatePath: string; // vault path of a .tex template; empty = built-in template
	author: string;
	newFileFolder: string; // empty = Obsidian's default location for new notes
	createBib: boolean;
	readableLineLength: boolean;
}

export const DEFAULT_SETTINGS: TexViewSettings = {
	templatePath: '',
	author: '',
	newFileFolder: '',
	createBib: true,
	readableLineLength: true,
};

const TEXT = {
	templateDesc: 'A .tex file used for new documents. Placeholders: {{title}}, {{author}}, {{date}} or {{date:YYYY-MM-DD}}, {{cursor}}. Leave empty for the built-in template.',
	authorDesc: 'Fills the {{author}} placeholder.',
	folderDesc: "Leave empty to use Obsidian's default location for new notes.",
	bibDesc: 'Create an empty bibliography file next to the new document when the template refers to one.',
	readableDesc: 'Limit the width of LaTeX documents, like readable line length does for notes.',
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

export class TexViewSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private plugin: TexViewPlugin,
	) {
		super(app, plugin);
	}

	// Declarative settings (Obsidian 1.13+): rendered by Obsidian and included in settings search.
	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				type: 'group',
				heading: 'Display',
				items: [{ name: 'Readable line length', desc: TEXT.readableDesc, control: { type: 'toggle', key: 'readableLineLength' } }],
			},
			{
				type: 'group',
				heading: 'New LaTeX documents',
				items: [
					{
						name: 'Template file',
						desc: TEXT.templateDesc,
						control: {
							type: 'file',
							key: 'templatePath',
							placeholder: 'templates/LaTeX document.tex',
							filter: (f) => f.extension === 'tex',
							validate: (v) => (v && !this.app.vault.getFileByPath(normalizePath(v)) ? 'File not found' : undefined),
						},
					},
					{ name: 'Author', desc: TEXT.authorDesc, control: { type: 'text', key: 'author' } },
					{ name: 'Folder for new documents', desc: TEXT.folderDesc, control: { type: 'folder', key: 'newFileFolder', placeholder: 'Default location' } },
					{ name: 'Create missing .bib files', desc: TEXT.bibDesc, control: { type: 'toggle', key: 'createBib' } },
				],
			},
		];
	}

	getControlValue(key: string): unknown {
		return this.plugin.settings[key as keyof TexViewSettings];
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		(this.plugin.settings as unknown as Record<string, unknown>)[key] = value;
		await this.plugin.saveSettings();
	}

	// Fallback for Obsidian versions before 1.13, which don't use getSettingDefinitions().
	display() {
		const { containerEl } = this;
		containerEl.empty();
		const s = this.plugin.settings;
		const save = () => void this.plugin.saveSettings();

		new Setting(containerEl).setName('Display').setHeading();
		new Setting(containerEl)
			.setName('Readable line length')
			.setDesc(TEXT.readableDesc)
			.addToggle((t) =>
				t.setValue(s.readableLineLength).onChange((v) => {
					s.readableLineLength = v;
					save();
				}),
			);

		new Setting(containerEl).setName('New LaTeX documents').setHeading();

		const templateSetting = new Setting(containerEl)
			.setName('Template file')
			.setDesc(TEXT.templateDesc);
		templateSetting.addText((text) => {
			text.setPlaceholder('templates/LaTeX document.tex').setValue(s.templatePath);
			text.onChange((v) => {
				s.templatePath = normalizePath(v.trim()) === '/' ? '' : v.trim();
				const ok = !s.templatePath || this.app.vault.getFileByPath(normalizePath(s.templatePath));
				text.inputEl.toggleClass('tex-setting-invalid', !ok);
				save();
			});
		});

		new Setting(containerEl)
			.setName('Author')
			.setDesc(TEXT.authorDesc)
			.addText((text) =>
				text.setValue(s.author).onChange((v) => {
					s.author = v;
					save();
				}),
			);

		new Setting(containerEl)
			.setName('Folder for new documents')
			.setDesc(TEXT.folderDesc)
			.addText((text) => {
				text.setPlaceholder('Default location').setValue(s.newFileFolder);
				text.onChange((v) => {
					s.newFileFolder = v.trim();
					save();
				});
			});

		new Setting(containerEl)
			.setName('Create missing .bib files')
			.setDesc(TEXT.bibDesc)
			.addToggle((t) =>
				t.setValue(s.createBib).onChange((v) => {
					s.createBib = v;
					save();
				}),
			);
	}
}
