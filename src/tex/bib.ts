// Small BibTeX parser. Field values are returned as raw LaTeX (outer braces removed).

export interface BibEntry {
	key: string;
	type: string;
	fields: Record<string, string>;
}

const MONTHS: Record<string, string> = {
	jan: 'January', feb: 'February', mar: 'March', apr: 'April', may: 'May', jun: 'June',
	jul: 'July', aug: 'August', sep: 'September', oct: 'October', nov: 'November', dec: 'December',
};

export function parseBib(src: string, into: Map<string, BibEntry> = new Map()): Map<string, BibEntry> {
	const strings: Record<string, string> = { ...MONTHS };
	let i = 0;
	const n = src.length;
	const skipWs = () => {
		while (i < n && /\s/.test(src[i]!)) i++;
	};
	const readBalanced = (open: string, close: string): string => {
		// assumes src[i] === open
		let depth = 0;
		const start = i + 1;
		for (; i < n; i++) {
			const c = src[i];
			if (c === '\\') {
				i++;
				continue;
			}
			if (c === open) depth++;
			else if (c === close) {
				depth--;
				if (depth === 0) {
					i++;
					return src.slice(start, i - 1);
				}
			}
		}
		return src.slice(start);
	};
	const readQuoted = (): string => {
		// src[i] === '"'; braces may contain quotes
		i++;
		const start = i;
		let depth = 0;
		for (; i < n; i++) {
			const c = src[i];
			if (c === '\\') {
				i++;
				continue;
			}
			if (c === '{') depth++;
			else if (c === '}') depth--;
			else if (c === '"' && depth === 0) {
				i++;
				return src.slice(start, i - 1);
			}
		}
		return src.slice(start);
	};
	const readValue = (): string => {
		let value = '';
		for (;;) {
			skipWs();
			const c = src[i];
			if (c === '{') value += readBalanced('{', '}');
			else if (c === '"') value += readQuoted();
			else {
				const m = /^[^\s,#}){]+/.exec(src.slice(i, i + 200));
				if (!m) break;
				i += m[0].length;
				const word = m[0];
				value += /^\d+$/.test(word) ? word : strings[word.toLowerCase()] ?? word;
			}
			skipWs();
			if (src[i] === '#') {
				i++;
				continue;
			}
			break;
		}
		return value;
	};

	while (i < n) {
		const at = src.indexOf('@', i);
		if (at < 0) break;
		i = at + 1;
		const tm = /^[A-Za-z]+/.exec(src.slice(i, i + 40));
		if (!tm) continue;
		const type = tm[0].toLowerCase();
		i += tm[0].length;
		skipWs();
		const open = src[i];
		if (open !== '{' && open !== '(') continue;
		const close = open === '{' ? '}' : ')';
		if (type === 'comment' || type === 'preamble') {
			readBalanced(open, close);
			continue;
		}
		i++;
		if (type === 'string') {
			skipWs();
			const nm = /^[^\s=]+/.exec(src.slice(i, i + 200));
			if (!nm) continue;
			i += nm[0].length;
			skipWs();
			if (src[i] === '=') i++;
			strings[nm[0].toLowerCase()] = readValue();
			skipWs();
			if (src[i] === close) i++;
			continue;
		}
		skipWs();
		const km = /^[^,\s]+/.exec(src.slice(i, i + 500));
		if (!km) continue;
		const key = km[0];
		i += key.length;
		const fields: Record<string, string> = {};
		for (;;) {
			skipWs();
			if (src[i] === ',') i++;
			skipWs();
			if (i >= n || src[i] === close) {
				i++;
				break;
			}
			const fm = /^[A-Za-z0-9_\-:.+]+/.exec(src.slice(i, i + 100));
			if (!fm) {
				// malformed: resync at next entry
				break;
			}
			i += fm[0].length;
			skipWs();
			if (src[i] !== '=') continue;
			i++;
			fields[fm[0].toLowerCase()] = readValue().replace(/\s+/g, ' ').trim();
		}
		into.set(key, { key, type, fields });
	}
	return into;
}

// Splits a BibTeX name list on top-level " and ".
export function splitNames(field: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let cur = '';
	const words = field.split(/(\s+)/);
	for (const w of words) {
		for (const c of w) {
			if (c === '{') depth++;
			else if (c === '}') depth--;
		}
		if (depth === 0 && w.toLowerCase() === 'and') {
			out.push(cur.trim());
			cur = '';
		} else cur += w;
	}
	if (cur.trim()) out.push(cur.trim());
	return out.filter(Boolean);
}

export interface Name {
	first: string;
	last: string; // includes "von" part
}

// Splits one name into first and last parts (raw LaTeX).
export function parseName(raw: string): Name {
	const parts = splitTopLevel(raw, ',');
	if (parts.length >= 2) {
		// "von Last, First" or "von Last, Jr, First"
		return { last: parts[0]!.trim(), first: parts[parts.length - 1]!.trim() };
	}
	const words = splitTopLevel(raw, ' ').filter(Boolean);
	if (words.length <= 1) return { first: '', last: raw.trim() };
	let lastStart = words.length - 1;
	// "von" particles: lowercase words before the last word
	for (let k = 1; k < words.length - 1; k++) {
		if (/^[a-z]/.test(words[k]!)) {
			lastStart = k;
			break;
		}
	}
	return { first: words.slice(0, lastStart).join(' '), last: words.slice(lastStart).join(' ') };
}

function splitTopLevel(s: string, sep: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let cur = '';
	for (let k = 0; k < s.length; k++) {
		const c = s[k]!;
		if (c === '\\') {
			cur += c + (s[k + 1] ?? '');
			k++;
			continue;
		}
		if (c === '{') depth++;
		else if (c === '}') depth--;
		if (depth === 0 && (sep === ' ' ? /\s/.test(c) : c === sep)) {
			out.push(cur);
			cur = '';
		} else cur += c;
	}
	out.push(cur);
	return out;
}
