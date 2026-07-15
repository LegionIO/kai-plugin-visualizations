/**
 * Headless render entry point. Bundled by esbuild into `render.js`, then loaded
 * into a hidden BrowserWindow by the backend (see src/backend/render-window.ts).
 *
 * It exposes a single global, `__vizRender(spec)`, that renders one visualization
 * to base64 image bytes. Everything is wrapped so the promise always resolves a
 * structured result the backend can inspect — `executeJavaScript` rejects ugly.
 */
import { renderMermaidToPng, renderMermaidToSvg, renderChartToPngDataUrl } from '../frontend/render-core';
import type { MermaidLook, MermaidCurve } from '../shared/types.js';

export type RenderSpec = {
  engine: 'mermaid' | 'chartjs';
  source: string;
  format: 'png' | 'svg';
  look?: MermaidLook;
  curve?: MermaidCurve;
  isDark?: boolean;
  /** When true, ignore isDark and resolve dark/light from the OS preference
   *  (used for the app's "system" theme, which only the renderer can resolve). */
  resolveSystemDark?: boolean;
  /** For forced styles: strip source %%{init}%% theme/look/themeCSS overrides. */
  lockStyle?: boolean;
  scale?: number;
  width?: number;
  height?: number;
};

export type RenderResult =
  | { ok: true; mediaType: string; base64: string }
  | { ok: false; error: string };

async function blobToBase64(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  let binary = '';
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function dataUrlToBase64(dataUrl: string): string {
  const comma = dataUrl.indexOf(',');
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
}

async function render(spec: RenderSpec): Promise<RenderResult> {
  try {
    // "system" theme can only be resolved here, where matchMedia exists.
    const isDark = spec.resolveSystemDark
      ? (globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true)
      : spec.isDark;
    const opts = { look: spec.look, curve: spec.curve, isDark, lockStyle: spec.lockStyle };

    if (spec.engine === 'mermaid') {
      if (spec.format === 'svg') {
        const svg = await renderMermaidToSvg(spec.source, { ...opts, embedBackground: true });
        return { ok: true, mediaType: 'image/svg+xml', base64: btoa(unescape(encodeURIComponent(svg))) };
      }
      const blob = await renderMermaidToPng(spec.source, { ...opts, scale: spec.scale });
      return { ok: true, mediaType: 'image/png', base64: await blobToBase64(blob) };
    }

    // chartjs
    if (spec.format === 'svg') {
      return { ok: false, error: 'Chart.js cannot export SVG; use format "png".' };
    }
    const dataUrl = renderChartToPngDataUrl(spec.source, {
      ...opts,
      width: spec.width,
      height: spec.height,
    });
    return { ok: true, mediaType: 'image/png', base64: dataUrlToBase64(dataUrl) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

(globalThis as unknown as { __vizRender: (spec: RenderSpec) => Promise<RenderResult> }).__vizRender =
  render;

// The backend injects this bundle via webContents.executeJavaScript, which
// structured-clones the script's completion value back to the main process.
// A function isn't cloneable ("An object could not be cloned"), so make the
// final expression a cloneable primitive.
void 0;

