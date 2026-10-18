// Prints the outline headings found in a .tex file.
import { readFileSync } from 'fs';
import { scanHeadings } from '../src/tex/headings';
for (const h of scanHeadings(readFileSync(process.argv[2]!, 'utf8'))) console.log(`${'  '.repeat(h.level - 2)}${h.text}  (line ${h.line + 1})`);
