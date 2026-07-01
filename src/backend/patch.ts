export type Hunk = { search: string; replace: string };

export type PatchParseResult =
  | { ok: true; hunks: Hunk[] }
  | { ok: false; error: string };

export type PatchApplyResult =
  | { ok: true; source: string; applied: number }
  | { ok: false; error: string; failedHunk: number };

const HUNK_RE =
  /<<<<<<< SEARCH\r?\n([\s\S]*?)\r?\n?=======\r?\n([\s\S]*?)\r?\n?>>>>>>> REPLACE/g;

export function parsePatch(body: string): PatchParseResult {
  const hunks: Hunk[] = [];
  let m: RegExpExecArray | null;
  HUNK_RE.lastIndex = 0;
  while ((m = HUNK_RE.exec(body)) !== null) {
    hunks.push({ search: m[1], replace: m[2] });
  }
  if (hunks.length === 0) {
    return { ok: false, error: 'No SEARCH/REPLACE hunks found in patch block.' };
  }
  return { ok: true, hunks };
}

/**
 * Apply hunks in order. Each hunk must match exactly once; if exact match fails,
 * a whitespace-normalized fallback (collapse runs of whitespace) is attempted.
 */
export function applyPatch(source: string, hunks: Hunk[]): PatchApplyResult {
  let current = source;
  for (let i = 0; i < hunks.length; i++) {
    const { search, replace } = hunks[i];
    if (search.length === 0) {
      return { ok: false, error: 'Hunk has empty SEARCH.', failedHunk: i + 1 };
    }
    const exactIdx = current.indexOf(search);
    if (exactIdx !== -1) {
      if (current.indexOf(search, exactIdx + 1) !== -1) {
        return {
          ok: false,
          error: `Hunk ${i + 1}: SEARCH text matches more than once; make it more specific.`,
          failedHunk: i + 1,
        };
      }
      current = current.slice(0, exactIdx) + replace + current.slice(exactIdx + search.length);
      continue;
    }
    const normIdx = normalizedIndexOf(current, search);
    if (normIdx) {
      current = current.slice(0, normIdx.start) + replace + current.slice(normIdx.end);
      continue;
    }
    return {
      ok: false,
      error: `Hunk ${i + 1}: SEARCH text not found in current source.`,
      failedHunk: i + 1,
    };
  }
  return { ok: true, source: current, applied: hunks.length };
}

/** Find `needle` in `hay` where all whitespace runs are treated as a single space. */
function normalizedIndexOf(hay: string, needle: string): { start: number; end: number } | null {
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  const nNeedle = norm(needle);
  if (!nNeedle) return null;
  // Slide a window over hay by non-ws token boundaries.
  const hayLen = hay.length;
  for (let start = 0; start < hayLen; start++) {
    if (/\s/.test(hay[start])) continue;
    let hi = start;
    let ni = 0;
    let lastHi = start;
    while (ni < nNeedle.length && hi < hayLen) {
      const hc = hay[hi];
      const nc = nNeedle[ni];
      if (nc === ' ') {
        if (!/\s/.test(hc)) break;
        while (hi < hayLen && /\s/.test(hay[hi])) hi++;
        ni++;
        lastHi = hi;
        continue;
      }
      if (hc !== nc) break;
      hi++;
      ni++;
      lastHi = hi;
    }
    if (ni === nNeedle.length) return { start, end: lastHi };
  }
  return null;
}
