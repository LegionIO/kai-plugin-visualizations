import { randomUUID } from 'crypto';
import type { Fragment } from '../shared/types.js';

export const FRAGMENT_MARKER = (name: string) => `%% ── fragment: ${name} ──`;
const MARKER_RE = /^%% ── fragment: (.+?) ──$/;

export function newFragment(name: string, source = ''): Fragment {
  return { id: randomUUID().slice(0, 8), name, source };
}

export function composeFragments(fragments: Fragment[]): string {
  if (fragments.length === 0) return '';
  if (fragments.length === 1) return fragments[0].source;
  return fragments.map((f) => `${FRAGMENT_MARKER(f.name)}\n${f.source}`).join('\n\n');
}

/**
 * Split composed source back into fragments, preserving ids from `existing`
 * where names match. Content before the first marker (or with no markers at
 * all) goes into the first existing fragment.
 */
export function decomposeFragments(source: string, existing: Fragment[]): Fragment[] {
  const lines = source.split('\n');
  const chunks: Array<{ name: string; body: string[] }> = [];
  let current: { name: string; body: string[] } | null = null;

  for (const line of lines) {
    const m = MARKER_RE.exec(line.trim());
    if (m) {
      if (current) chunks.push(current);
      current = { name: m[1], body: [] };
    } else {
      if (!current) current = { name: existing[0]?.name ?? 'main', body: [] };
      current.body.push(line);
    }
  }
  if (current) chunks.push(current);

  const byName = new Map(existing.map((f) => [f.name, f]));
  return chunks.map((c) => {
    const prev = byName.get(c.name);
    return {
      id: prev?.id ?? randomUUID().slice(0, 8),
      name: c.name,
      source: c.body.join('\n').replace(/^\n+/, '').replace(/\n+$/, ''),
    };
  });
}

export function summarizeFragments(fragments: Fragment[]): Array<{
  name: string;
  lines: number;
  bytes: number;
  head: string;
}> {
  return fragments.map((f) => ({
    name: f.name,
    lines: f.source ? f.source.split('\n').length : 0,
    bytes: f.source.length,
    head: f.source.split('\n')[0]?.slice(0, 80) ?? '',
  }));
}

export function grepFragments(
  fragments: Fragment[],
  pattern: string,
  opts: { regex?: boolean; caseSensitive?: boolean } = {},
): Array<{ fragment: string; line: number; text: string }> {
  const results: Array<{ fragment: string; line: number; text: string }> = [];
  let matcher: (line: string) => boolean;
  if (opts.regex) {
    try {
      const re = new RegExp(pattern, opts.caseSensitive ? '' : 'i');
      matcher = (l) => re.test(l);
    } catch {
      const p = opts.caseSensitive ? pattern : pattern.toLowerCase();
      matcher = (l) => (opts.caseSensitive ? l : l.toLowerCase()).includes(p);
    }
  } else {
    const p = opts.caseSensitive ? pattern : pattern.toLowerCase();
    matcher = (l) => (opts.caseSensitive ? l : l.toLowerCase()).includes(p);
  }
  for (const f of fragments) {
    const lines = f.source.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (matcher(lines[i])) results.push({ fragment: f.name, line: i + 1, text: lines[i] });
      if (results.length >= 200) return results;
    }
  }
  return results;
}
