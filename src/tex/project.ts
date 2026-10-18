// Multi-file handling: resolves \input/\include and finds bibliography files.

import { isCommented, stripComments } from './parse';

// Reads a file given a path relative to the main file's folder; null if missing.
export type ReadFn = (relPath: string) => Promise<string | null>;

export interface Expanded {
	src: string;
	files: string[]; // included files that were found (relative paths)
	missing: string[];
}

const INCLUDE_RE = /\\(input|include|subfile)\s*\{([^}]*)\}|\\input\s+([^\s{}%\\]+)/g;

export async function expandIncludes(src: string, read: ReadFn, depth = 0, seen = new Set<string>()): Promise<Expanded> {
	const files: string[] = [];
	const missing: string[] = [];
	if (depth > 10) return { src, files, missing };
	let out = '';
	let last = 0;
	INCLUDE_RE.lastIndex = 0;
	const matches = [...src.matchAll(INCLUDE_RE)];
	for (const m of matches) {
		if (isCommented(src, m.index!)) continue;
		const name = (m[2] ?? m[3] ?? '').trim();
		if (!name) continue;
		const candidates = /\.[A-Za-z]+$/.test(name) ? [name] : [`${name}.tex`, name];
		let content: string | null = null;
		let found = '';
		for (const c of candidates) {
			if (seen.has(c)) continue;
			content = await read(c);
			if (content !== null) {
				found = c;
				break;
			}
		}
		out += src.slice(last, m.index);
		last = m.index! + m[0].length;
		if (content === null) {
			missing.push(name);
			continue;
		}
		files.push(found);
		const inner = await expandIncludes(content, read, depth + 1, new Set([...seen, found]));
		files.push(...inner.files);
		missing.push(...inner.missing);
		// Keep included content on its own lines, like TeX's \input does with line ends.
		out += '\n' + inner.src + '\n';
	}
	out += src.slice(last);
	return { src: out, files, missing };
}

// Bibliography files named by \bibliography{a,b} or \addbibresource{x.bib}.
export function findBibFiles(src: string): string[] {
	const s = stripComments(src);
	const out: string[] = [];
	for (const m of s.matchAll(/\\bibliography\s*\{([^}]*)\}/g)) {
		for (const name of m[1]!.split(',')) {
			const n = name.trim();
			if (n) out.push(/\.bib$/.test(n) ? n : `${n}.bib`);
		}
	}
	for (const m of s.matchAll(/\\addbibresource\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g)) {
		const n = m[1]!.trim();
		if (n) out.push(n);
	}
	return [...new Set(out)];
}
