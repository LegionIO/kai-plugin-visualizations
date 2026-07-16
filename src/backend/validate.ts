import type { Engine } from '../shared/types.js';

export type ValidationResult =
  | { valid: true }
  | { valid: false; error: string; line?: number };

/**
 * Mermaid parses through DOMPurify, which needs a live DOM (`window`/`document`)
 * to register its sanitizer hooks. The plugin backend runs in a DOM-less Node
 * host, where `DOMPurify.addHook` is undefined and `mermaid.parse` throws
 * "addHook is not a function" — a bogus "invalid diagram" that has nothing to do
 * with the source. We can't supply a DOM here: jsdom can't be esbuild-bundled
 * (dynamic requires) and the plugin ships as a self-contained bundle with no
 * node_modules to externalize it into. So we only attempt real mermaid
 * validation when a DOM already exists (e.g. an Electron renderer); in a
 * headless host we skip it and treat the diagram as valid. Genuine syntax errors
 * still surface at render time, which runs in a real browser window.
 */
function hasDom(): boolean {
  const g = globalThis as { window?: unknown; document?: unknown };
  return typeof g.window !== 'undefined' && typeof g.document !== 'undefined';
}

let mermaidParse: ((src: string) => Promise<unknown>) | null | undefined;

async function getMermaidParse(): Promise<((src: string) => Promise<unknown>) | null> {
  if (mermaidParse !== undefined) return mermaidParse;
  if (!hasDom()) {
    mermaidParse = null;
    return mermaidParse;
  }
  try {
    const mod = await import('mermaid');
    const m = (mod as { default?: { initialize: (c: unknown) => void; parse: (s: string) => Promise<unknown> } })
      .default;
    m?.initialize({ startOnLoad: false });
    mermaidParse = m ? (s) => m.parse(s) : null;
  } catch {
    mermaidParse = null;
  }
  return mermaidParse;
}

function extractLine(msg: string): number | undefined {
  const m = /line\s+(\d+)/i.exec(msg);
  return m ? Number(m[1]) : undefined;
}

export async function validateSource(engine: Engine, source: string): Promise<ValidationResult> {
  const trimmed = source.trim();
  if (!trimmed) return { valid: true };

  if (engine === 'chartjs') {
    try {
      const cfg = JSON.parse(trimmed);
      if (!cfg || typeof cfg !== 'object' || !('type' in cfg) || !('data' in cfg)) {
        return { valid: false, error: 'Chart config must be a JSON object with "type" and "data".' };
      }
      return { valid: true };
    } catch (e) {
      return { valid: false, error: `Invalid JSON: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  const parse = await getMermaidParse();
  if (!parse) return { valid: true };
  try {
    await parse(trimmed);
    return { valid: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { valid: false, error: msg, line: extractLine(msg) };
  }
}
