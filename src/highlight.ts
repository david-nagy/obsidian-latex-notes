// Lightweight LaTeX syntax colouring for the visible part of the editor.
// Uses plain mark decorations, so it does not depend on Lezer highlight tags
// (which are not shared between plugins and Obsidian's own CodeMirror).

import { RangeSetBuilder } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from '@codemirror/view';

const marks = {
	cmd: Decoration.mark({ class: 'tex-tok-cmd' }),
	env: Decoration.mark({ class: 'tex-tok-env' }),
	math: Decoration.mark({ class: 'tex-tok-math' }),
	comment: Decoration.mark({ class: 'tex-tok-comment' }),
};

const TOKEN = /(\\(?:begin|end)\s*)(\{[^}\n]*\})|\\[A-Za-z@]+\*?|\\.|\$\$?|%/g;

function highlightLine(text: string, offset: number, add: (from: number, to: number, m: Decoration) => void) {
	let mathStart = -1;
	TOKEN.lastIndex = 0;
	for (let m = TOKEN.exec(text); m; m = TOKEN.exec(text)) {
		const tok = m[0];
		const at = m.index;
		if (tok === '%') {
			if (mathStart >= 0) add(offset + mathStart, offset + at, marks.math);
			add(offset + at, offset + text.length, marks.comment);
			return;
		}
		if (tok === '$' || tok === '$$') {
			if (mathStart < 0) mathStart = at;
			else {
				add(offset + mathStart, offset + at + tok.length, marks.math);
				mathStart = -1;
			}
			continue;
		}
		if (mathStart >= 0) continue; // commands inside inline math keep the math colour
		if (m[1] && m[2]) {
			add(offset + at, offset + at + m[1].length, marks.cmd);
			add(offset + at + m[1].length, offset + at + tok.length, marks.env);
		} else if (/^\\[A-Za-z@]/.test(tok)) add(offset + at, offset + at + tok.length, marks.cmd);
	}
	if (mathStart >= 0) add(offset + mathStart, offset + text.length, marks.math);
}

function build(view: EditorView): DecorationSet {
	const builder = new RangeSetBuilder<Decoration>();
	let done = -1; // end of the last processed line; ranges must be added in order
	for (const { from, to } of view.visibleRanges) {
		for (let pos = Math.max(from, done + 1); pos <= to; ) {
			const line = view.state.doc.lineAt(pos);
			if (line.from > done) {
				highlightLine(line.text, line.from, (a, b, m) => {
					if (b > a) builder.add(a, b, m);
				});
			}
			done = line.to;
			pos = line.to + 1;
		}
	}
	return builder.finish();
}

export const texHighlighter = ViewPlugin.fromClass(
	class {
		decorations: DecorationSet;
		constructor(view: EditorView) {
			this.decorations = build(view);
		}
		update(u: ViewUpdate) {
			if (u.docChanged || u.viewportChanged) this.decorations = build(u.view);
		}
	},
	{ decorations: (v) => v.decorations },
);
