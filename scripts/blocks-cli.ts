// Prints how a .tex file is split into live-preview blocks and converted.
import { promises as fs } from 'fs';
import * as path from 'path';
import { segment } from '../src/tex/blocks';
import { convertBlocks } from '../src/tex/convert';
import { parseBib, BibEntry } from '../src/tex/bib';
import { findBibFiles } from '../src/tex/project';

async function main() {
	const file = process.argv[2]!;
	const text = await fs.readFile(file, 'utf8');
	const seg = segment(text);
	const bib = new Map<string, BibEntry>();
	for (const b of findBibFiles(text)) {
		try { parseBib(await fs.readFile(path.join(path.dirname(file), b), 'utf8'), bib); } catch { /* missing */ }
	}
	const t0 = Date.now();
	const res = convertBlocks(seg.preamble ? text.slice(seg.preamble.from, seg.preamble.to) : '', seg.blocks.map((b) => text.slice(b.from, b.to)), { bib, resolveAsset: (p) => ({ kind: 'image', src: p, path: p }) });
	const ms = Date.now() - t0;
	const lens = seg.blocks.map((b) => text.slice(b.from, b.to).split('\n').length);
	const empty = res.blocks.filter((m) => !m.trim()).length;
	console.log(JSON.stringify({ ms, blocks: seg.blocks.length, maxLines: Math.max(...lens), emptyBlocks: empty, preamble: seg.preamble, end: seg.end, head: res.head.slice(0, 80), tail: res.tail.slice(0, 60) }));
	const big = lens.map((l, i) => [l, i]).sort((a, b) => b[0]! - a[0]!).slice(0, 3);
	for (const [l, i] of big) console.log(`  biggest block #${i}: ${l} lines: ${JSON.stringify(text.slice(seg.blocks[i!]!.from, seg.blocks[i!]!.from + 70))}`);
}
main();
