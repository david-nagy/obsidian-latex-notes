// Splits a LaTeX source into editable blocks: top-level paragraphs separated by
// blank lines. Environments and brace groups are never split, so a figure or an
// align block that contains blank lines stays one block.

import { RAW_ENVS } from './parse';

export interface SrcBlock {
	from: number; // offset of the first character (line start)
	to: number; // offset after the last character of the last line (excluding newline)
}

export interface Segmentation {
	preamble: SrcBlock | null; // up to and including the \begin{document} line
	blocks: SrcBlock[]; // body blocks
	end: SrcBlock | null; // the \end{document} line and everything after it
}

const BEGIN_DOC = /^[ \t]*\\begin\s*\{document\}/;
const END_DOC = /^[ \t]*\\end\s*\{document\}/;

export function segment(text: string): Segmentation {
	const lines: { from: number; to: number; s: string }[] = [];
	let pos = 0;
	for (const s of text.split('\n')) {
		lines.push({ from: pos, to: pos + s.length, s });
		pos += s.length + 1;
	}

	let first = 0;
	let preamble: SrcBlock | null = null;
	const beginIdx = lines.findIndex((l) => BEGIN_DOC.test(l.s));
	if (beginIdx >= 0) {
		preamble = { from: 0, to: lines[beginIdx]!.to };
		first = beginIdx + 1;
	}
	let last = lines.length - 1;
	let end: SrcBlock | null = null;
	if (beginIdx >= 0) {
		for (let k = lines.length - 1; k > beginIdx; k--) {
			if (END_DOC.test(lines[k]!.s)) {
				end = { from: lines[k]!.from, to: text.length };
				last = k - 1;
				break;
			}
		}
	}

	const blocks: SrcBlock[] = [];
	let start = -1;
	let envDepth = 0;
	let braceDepth = 0;
	const rawStack: string[] = [];
	for (let k = first; k <= last; k++) {
		const line = lines[k]!;
		const blank = line.s.trim() === '';
		if (blank && start >= 0 && envDepth <= 0 && braceDepth <= 0 && !rawStack.length) {
			blocks.push({ from: lines[start]!.from, to: lines[k - 1]!.to });
			start = -1;
			continue;
		}
		if (blank) continue;
		if (start < 0) {
			start = k;
			envDepth = Math.max(0, envDepth);
			braceDepth = Math.max(0, braceDepth);
		}
		scanLine(line.s, rawStack, (d) => (envDepth += d), (d) => (braceDepth += d));
	}
	if (start >= 0) blocks.push({ from: lines[start]!.from, to: lines[last]!.to });
	return { preamble, blocks, end };
}

function scanLine(s: string, rawStack: string[], env: (d: number) => void, brace: (d: number) => void) {
	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		if (c === '%' && !rawStack.length) return;
		if (c === '\\') {
			const m = /^\\(begin|end)\s*\{([^}]*)\}/.exec(s.slice(i, i + 80));
			if (m) {
				const name = m[2]!.trim();
				if (rawStack.length) {
					if (m[1] === 'end' && name === rawStack[rawStack.length - 1]) {
						rawStack.pop();
						env(-1);
					} else if (m[1] === 'begin' && name === rawStack[rawStack.length - 1]) {
						rawStack.push(name);
						env(1);
					}
				} else if (name !== 'document') {
					if (m[1] === 'begin') {
						env(1);
						if (RAW_ENVS.has(name) && !name.startsWith('equation') && name !== 'math') rawStack.push(name);
					} else env(-1);
				}
				i += m[0].length - 1;
				continue;
			}
			i++; // skip escaped char such as \{ or \%
			continue;
		}
		if (rawStack.length) continue;
		if (c === '{') brace(1);
		else if (c === '}') brace(-1);
	}
}
