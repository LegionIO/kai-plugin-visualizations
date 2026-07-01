import type { Engine } from '../shared/types.js';

export type ValidationResult =
  | { valid: true }
  | { valid: false; error: string; line?: number };

let mermaidParse: ((src: string) => Promise<unknown>) | null | undefined;

async function getMermaidParse(): Promise<((src: string) => Promise<unknown>) | null> {
  if (mermaidParse !== undefined) return mermaidParse;
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
