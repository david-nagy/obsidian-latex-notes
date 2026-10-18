// Converts a .tex file to markdown on the command line, for testing the converter.
// Usage: node build/convert-cli.js <file.tex> [out.md]

import { promises as fs, existsSync } from 'fs';
import * as path from 'path';
import { convert } from '../src/tex/convert';
import { parseBib, BibEntry } from '../src/tex/bib';
import { expandIncludes, findBibFiles } from '../src/tex/project';

const IMAGE_EXTS = ['', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.pdf'];

async function main() {
	const [file, outFile] = process.argv.slice(2);
	if (!file) throw new Error('usage: convert-cli <file.tex> [out.md]');
	const dir = path.dirname(file);
	const read = async (rel: string) => {
		try {
			return await fs.readFile(path.join(dir, rel), 'utf8');
		} catch {
			return null;
		}
	};
	const t0 = Date.now();
	const main = await fs.readFile(file, 'utf8');
	const expanded = await expandIncludes(main, read);
	const bib = new Map<string, BibEntry>();
	const bibFiles = findBibFiles(expanded.src);
	for (const b of bibFiles) {
		const s = await read(b);
		if (s) parseBib(s, bib);
		else console.log('bib not found:', b);
	}
	const res = convert(expanded.src, {
		bib,
		resolveAsset: (p) => {
			for (const ext of IMAGE_EXTS) {
				const full = path.join(dir, p + ext);
				if (existsSync(full) && !full.endsWith('/')) {
					return { kind: full.endsWith('.pdf') ? 'pdf' : 'image', src: full, path: full };
				}
			}
			return null;
		},
	});
	const ms = Date.now() - t0;
	if (outFile) await fs.writeFile(outFile, res.markdown);
	else process.stdout.write(res.markdown);
	console.error(JSON.stringify({ ms, includes: expanded.files, missingIncludes: expanded.missing, bibFiles, bibEntries: bib.size, ...res.diagnostics }, null, 1));
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
