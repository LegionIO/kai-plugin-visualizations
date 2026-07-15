/**
 * Framework-free rendering used by both the interactive UI (via ExportMenu) and
 * the headless background export (src/render, run inside a hidden BrowserWindow).
 *
 * Everything here must work without React and without the plugin host — it only
 * touches the DOM/canvas of whatever document it runs in. The mermaid/chartjs
 * theming mirrors MermaidRenderer/ChartRenderer so exports look like the panel.
 */
import mermaid from 'mermaid';
import DOMPurify from 'dompurify';
import { Chart } from 'chart.js/auto';
import type { ChartConfiguration } from 'chart.js';
import { chartSkin, applyChartSkin } from './chart-looks';
import type { MermaidLook, MermaidCurve } from '../shared/types.js';

/* ── mermaid theming (kept in sync with MermaidRenderer.tsx) ── */

const BASE_THEME_CSS = `
  .node rect, .node polygon, .node circle, .node ellipse, .node path, .cluster rect {
    filter: drop-shadow(0 2px 4px rgba(0,0,0,0.25));
  }
  .cluster rect { rx: 8px; }
`;

const NEO_THEME_CSS = `
  .node rect, .node polygon, .node circle, .node ellipse, .node path {
    fill: url(#neo-node-gradient);
    rx: 10px;
    stroke-width: 1.5px;
    filter: drop-shadow(0 0 6px rgba(56,189,248,0.35)) drop-shadow(0 4px 12px rgba(0,0,0,0.5));
  }
  .node rect[style*="fill:"], .node polygon[style*="fill:"], .node path[style*="fill:"] {
    fill: unset;
  }
  .cluster rect {
    rx: 14px;
    fill: rgba(15,23,42,0.45);
    stroke: rgba(56,189,248,0.5);
    stroke-width: 1.5px;
    stroke-dasharray: 4 3;
    filter: drop-shadow(0 0 12px rgba(56,189,248,0.15));
  }
  .cluster-label text, .cluster-label tspan {
    fill: #7dd3fc;
    font-weight: 600;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    font-size: 11px;
  }
  .node .label text, .node .label tspan { fill: #e5e7eb; font-weight: 500; }
  .edgePaths path.flowchart-link, .edgePath path, .messageLine0, .messageLine1 {
    stroke: url(#neo-edge-gradient) #38bdf8;
    stroke-width: 1.75px;
    filter: drop-shadow(0 0 3px rgba(56,189,248,0.6));
  }
  .marker, .arrowheadPath { fill: #38bdf8; stroke: #38bdf8; }
  .edgeLabel rect, .edgeLabel .label-container {
    fill: rgba(2,6,23,0.85);
    stroke: rgba(56,189,248,0.4);
    rx: 6px;
  }
  .edgeLabel text, .edgeLabel tspan { fill: #cbd5e1; }
`;

const NEO_DEFS = `
  <linearGradient id="neo-node-gradient" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="#1e293b"/>
    <stop offset="100%" stop-color="#0f172a"/>
  </linearGradient>
  <linearGradient id="neo-edge-gradient" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0%" stop-color="#38bdf8"/>
    <stop offset="100%" stop-color="#a78bfa"/>
  </linearGradient>
`;

const NEO_THEME_VARS = {
  darkMode: true,
  background: '#020617',
  primaryColor: '#1e293b',
  primaryBorderColor: '#38bdf8',
  primaryTextColor: '#e5e7eb',
  secondaryColor: '#0f172a',
  tertiaryColor: '#0b1220',
  lineColor: '#38bdf8',
  clusterBkg: '#0f172a',
  clusterBorder: '#38bdf8',
  edgeLabelBackground: '#020617',
  fontSize: '14px',
};

type MermaidSkin = {
  mermaidLook: 'classic' | 'handDrawn';
  theme: 'base' | 'dark' | 'default';
  themeCSS: string;
  themeVariables: Record<string, unknown>;
  injectDefs?: string;
  canvasBg?: string;
};

function mermaidThemeFor(look: MermaidLook, isDark: boolean): MermaidSkin {
  if (look === 'neo') {
    return {
      mermaidLook: 'classic',
      theme: 'base',
      themeCSS: NEO_THEME_CSS,
      themeVariables: NEO_THEME_VARS,
      injectDefs: NEO_DEFS,
      canvasBg: '#020617',
    };
  }
  return {
    mermaidLook: look === 'handDrawn' ? 'handDrawn' : 'classic',
    theme: isDark ? 'dark' : 'default',
    themeCSS: BASE_THEME_CSS,
    themeVariables: { fontSize: '14px', primaryBorderColor: isDark ? '#4b5563' : '#94a3b8' },
  };
}

/**
 * Sanitize mermaid's SVG for a standalone export. Unlike the interactive
 * renderer (which keeps viz:// hrefs for navigation), an exported SVG is opened
 * outside our CSP, so any external reference it carries — `<image href>`,
 * `<a href="https://…">`, `url(http…)` fills — would fetch on open and leak a
 * request. Strip every non-local URL reference; exports aren't interactive.
 */
function sanitizeSvg(svg: string): string {
  const isLocalRef = (v: string | null): boolean => !!v && v.trim().startsWith('#');
  // CSS escapes (`\72` → 'r', `\75 \72 \6c` → 'url') let attackers hide `url(`
  // from a naive regex while browsers still decode and honor it. Decode escapes
  // BEFORE scrubbing so the pattern matches the value the browser will see.
  const decodeCssEscapes = (css: string): string =>
    css
      .replace(/\\([0-9a-fA-F]{1,6})[ \t\n\f\r]?/g, (_m, hex) => {
        const cp = parseInt(hex, 16);
        return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
      })
      .replace(/\\(.)/g, '$1');
  // True only for a resource target that is a same-document #fragment (the sole
  // legitimate case — gradient/filter refs). Quotes and whitespace are stripped
  // first so `url("#g")` and `url( #g )` are correctly treated as local.
  const isLocalTarget = (raw: string): boolean =>
    raw.trim().replace(/^['"]|['"]$/g, '').trim().startsWith('#');
  // Neutralize every CSS construct that can fetch: url(), image-set()/image()/
  // -webkit-image-set(), src(), and @import (both url(...) and bare-string
  // forms). Anything whose target isn't a #fragment is replaced with `none`.
  const scrubCss = (css: string): string => {
    let out = decodeCssEscapes(css);
    // @import "…"; / @import url(…);
    out = out.replace(/@import\s+[^;]*;?/gi, (m) =>
      /["']\s*#|url\(\s*['"]?\s*#/.test(m) ? m : '',
    );
    // resource functions with a parenthesized payload
    out = out.replace(
      /(?:url|image-set|image|-webkit-image-set|src)\(\s*([^)]*)\)/gi,
      (m, inner: string) => (isLocalTarget(inner) ? m : 'none'),
    );
    return out;
  };
  const hasExternalCss = (css: string): boolean => scrubCss(css) !== decodeCssEscapes(css);
  const stripExternal = (node: Node): void => {
    if (node instanceof Element && node.tagName.toLowerCase() === 'style') {
      const css = node.textContent ?? '';
      if (hasExternalCss(css)) node.textContent = scrubCss(css);
      return;
    }
    if (!(node instanceof Element)) return;
    for (const attr of ['href', 'xlink:href']) {
      const val = node.getAttribute(attr);
      if (val !== null && !isLocalRef(val)) node.removeAttribute(attr);
    }
    // Inline style/fill/... referencing an external url() (e.g. url(http://…)).
    for (const attr of ['style', 'fill', 'stroke', 'filter', 'clip-path', 'mask']) {
      const val = node.getAttribute(attr);
      if (!val) continue;
      if (attr === 'style') {
        if (hasExternalCss(val)) node.setAttribute('style', scrubCss(val));
      } else if (hasExternalCss(val)) {
        node.removeAttribute(attr);
      }
    }
  };
  DOMPurify.addHook('afterSanitizeAttributes', stripExternal);
  try {
    return DOMPurify.sanitize(svg, {
      ADD_TAGS: ['foreignObject', 'style'],
      ADD_ATTR: [
        'transform', 'dominant-baseline', 'text-anchor', 'stroke-dasharray', 'stroke-width',
        'marker-end', 'marker-start', 'dx', 'dy', 'x', 'y', 'rx', 'ry',
      ],
    });
  } finally {
    DOMPurify.removeHook('afterSanitizeAttributes');
  }
}

export type RenderOpts = {
  look?: MermaidLook;
  curve?: MermaidCurve;
  isDark?: boolean;
  /** Strip source %%{init}%%/%%{config}%% directives so a forced style can't be
   *  overridden by theme/look/themeCSS in the diagram source. */
  lockStyle?: boolean;
};

/**
 * Remove mermaid config front-matter from source so it can't override a forced
 * export style (theme/look/themeCSS). Mermaid honors two forms:
 *  - legacy `%%{init: {...}}%%` / `%%{config: {...}}%%` directives, and
 *  - a leading YAML front-matter block delimited by `---` lines (v11), whose
 *    `config:` key merges like an init directive.
 * For a forced style we strip both; the diagram content itself is unaffected.
 */
function stripInitDirectives(source: string): string {
  let out = source.replace(/%%\{\s*(?:init|config)\b[\s\S]*?\}%%/gi, '');
  // Leading YAML front matter: optional whitespace, `---`, …, closing `---`.
  out = out.replace(/^\s*---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/, '');
  return out;
}

/**
 * Render mermaid source to a sanitized standalone SVG string. Throws on parse
 * error. When `embedBackground` is set, a solid background rect for the look is
 * inserted as the first child so the standalone SVG isn't transparent (dark/neo
 * diagrams are unreadable on a viewer's default white). The PNG path leaves it
 * transparent and paints the background on its own canvas instead.
 */
export async function renderMermaidToSvg(
  source: string,
  opts: RenderOpts & { embedBackground?: boolean } = {},
): Promise<string> {
  const skin = mermaidThemeFor(opts.look ?? 'classic', opts.isDark ?? true);
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'loose',
    theme: skin.theme,
    look: skin.mermaidLook,
    fontFamily: 'ui-sans-serif, system-ui, sans-serif',
    themeCSS: skin.themeCSS,
    themeVariables: skin.themeVariables,
    htmlLabels: false,
    flowchart: {
      htmlLabels: false,
      useMaxWidth: false,
      curve: opts.curve ?? 'basis',
      padding: 14,
      nodeSpacing: 55,
      rankSpacing: 65,
    },
    class: { htmlLabels: false },
    er: { useMaxWidth: false },
    sequence: { useMaxWidth: false },
  });

  const renderId = `viz-export-${Math.random().toString(36).slice(2, 10)}`;
  try {
    const src = opts.lockStyle ? stripInitDirectives(source) : source;
    const { svg } = await mermaid.render(renderId, src);
    let final = svg;
    if (skin.injectDefs) {
      final = final.replace(/(<svg[^>]*>)/, `$1<defs>${skin.injectDefs}</defs>`);
    }
    const clean = sanitizeSvg(final);
    if (opts.embedBackground) {
      const bg = mermaidCanvasBg(opts.look, opts.isDark ?? true);
      // mermaid emits a negative viewBox origin for padding (e.g. "-8 -8 W H"),
      // so a rect at 0,0 leaves transparent top/left strips. Derive the rect
      // from the viewBox when present; fall back to a full-bleed percentage box.
      const vb = /viewBox\s*=\s*["']\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s*["']/i.exec(clean);
      const rect = vb
        ? `<rect x="${vb[1]}" y="${vb[2]}" width="${vb[3]}" height="${vb[4]}" fill="${bg}"/>`
        : `<rect x="-10000" y="-10000" width="20000" height="20000" fill="${bg}"/>`;
      return clean.replace(/(<svg[^>]*>)/, `$1${rect}`);
    }
    return clean;
  } finally {
    document.getElementById(renderId)?.remove();
  }
}

/** Background color to paint behind a mermaid export for the given look. */
export function mermaidCanvasBg(look: MermaidLook | undefined, isDark: boolean): string {
  return mermaidThemeFor(look ?? 'classic', isDark).canvasBg ?? (isDark ? '#0b1220' : '#ffffff');
}

/* ── SVG → PNG rasterization (shared with ExportMenu) ── */

function intrinsicSize(svgEl: SVGSVGElement): { w: number; h: number } {
  const vb = svgEl.viewBox?.baseVal;
  if (vb && vb.width > 0 && vb.height > 0) return { w: vb.width, h: vb.height };
  try {
    const bb = svgEl.getBBox();
    if (bb.width > 0 && bb.height > 0) return { w: bb.width, h: bb.height };
  } catch {
    /* getBBox can throw on detached SVG */
  }
  const r = svgEl.getBoundingClientRect();
  return { w: r.width || 1, h: r.height || 1 };
}

/** Rasterize a live <svg> element to a PNG blob at the given supersampling scale. */
export async function svgToPng(svgEl: SVGSVGElement, scale = 2, background?: string): Promise<Blob> {
  const clone = svgEl.cloneNode(true) as SVGSVGElement;
  const { w: iw, h: ih } = intrinsicSize(svgEl);
  if (!Number.isFinite(iw) || !Number.isFinite(ih) || iw <= 0 || ih <= 0) {
    throw new Error('SVG has no usable dimensions to rasterize.');
  }
  const w = Math.max(1, Math.round(iw));
  const h = Math.max(1, Math.round(ih));
  // The diagram source controls w/h; clamp the rasterized output so a huge
  // (or maliciously large) diagram can't allocate a canvas big enough to crash
  // the renderer. Compute the downscale factor with overflow-safe arithmetic
  // (w*h can be Infinity for absurd inputs) and cap each side AND total pixels.
  const MAX_SIDE = 8192;
  const MAX_PIXELS = 24_000_000; // ~24 MP output ceiling
  let eff = Math.max(1, scale);
  eff = Math.min(eff, MAX_SIDE / w, MAX_SIDE / h);
  // Area cap: eff^2 * w * h <= MAX_PIXELS  ⇒  eff <= sqrt(MAX_PIXELS/w) / sqrt(h),
  // split so neither intermediate overflows for very large w/h.
  const areaEff = Math.sqrt(MAX_PIXELS / w) / Math.sqrt(h);
  if (Number.isFinite(areaEff) && areaEff > 0) eff = Math.min(eff, areaEff);
  if (!Number.isFinite(eff) || eff <= 0) {
    // Intrinsic size alone exceeds the budget; downscale to fit the pixel cap.
    eff = Math.min(MAX_SIDE / w, MAX_SIDE / h, Math.sqrt(MAX_PIXELS / w) / Math.sqrt(h));
    if (!Number.isFinite(eff) || eff <= 0) throw new Error('SVG dimensions too large to rasterize.');
  }
  let cw = Math.min(MAX_SIDE, Math.max(1, Math.round(w * eff)));
  let ch = Math.min(MAX_SIDE, Math.max(1, Math.round(h * eff)));
  // Final hard guard: if rounding/side-caps still leave us over the pixel
  // budget, shrink proportionally.
  if (cw * ch > MAX_PIXELS) {
    const k = Math.sqrt(MAX_PIXELS / (cw * ch));
    cw = Math.max(1, Math.floor(cw * k));
    ch = Math.max(1, Math.floor(ch * k));
  }
  clone.setAttribute('width', String(w));
  clone.setAttribute('height', String(h));
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  const xml = new XMLSerializer().serializeToString(clone);
  const svgBlob = new Blob([xml], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(svgBlob);
  try {
    const img = new Image();
    await new Promise<void>((res, rej) => {
      const t = setTimeout(() => rej(new Error('SVG rasterization timed out')), 10000);
      img.onload = () => {
        clearTimeout(t);
        res();
      };
      img.onerror = () => {
        clearTimeout(t);
        rej(new Error('Failed to load SVG as image'));
      };
      img.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext('2d')!;
    if (background) {
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, cw, ch);
    }
    // Scale the drawn image to fill the (clamped) canvas rather than relying on
    // ctx.scale, so the output stays consistent when eff was capped below scale.
    ctx.drawImage(img, 0, 0, cw, ch);
    return await new Promise<Blob>((res, rej) =>
      canvas.toBlob((b) => (b ? res(b) : rej(new Error('toBlob failed'))), 'image/png'),
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Render a mermaid source string all the way to a PNG blob, off-DOM. Mounts the
 * SVG in a detached-but-laid-out container so getBBox works, then rasterizes.
 */
export async function renderMermaidToPng(
  source: string,
  opts: RenderOpts & { scale?: number } = {},
): Promise<Blob> {
  const svgText = await renderMermaidToSvg(source, opts);
  // The SVG needs to be in the live document for getBBox/getBoundingClientRect
  // to report real dimensions; hide it far off-screen so nothing flashes.
  const holder = document.createElement('div');
  holder.style.cssText = 'position:fixed;left:-99999px;top:0;opacity:0;pointer-events:none;';
  holder.innerHTML = svgText;
  document.body.appendChild(holder);
  try {
    const svgEl = holder.querySelector('svg') as SVGSVGElement | null;
    if (!svgEl) throw new Error('mermaid produced no <svg>');
    const bg = mermaidCanvasBg(opts.look, opts.isDark ?? true);
    return await svgToPng(svgEl, opts.scale ?? 2, bg);
  } finally {
    holder.remove();
  }
}

/* ── chart.js → PNG ── */

/**
 * Render a Chart.js config (JSON string) to a PNG data-URL on an off-screen
 * canvas. Animation is disabled so the first frame is complete synchronously —
 * hidden windows throttle requestAnimationFrame, which would otherwise leave the
 * canvas blank.
 */
export function renderChartToPngDataUrl(
  source: string,
  opts: RenderOpts & { width?: number; height?: number } = {},
): string {
  const parsed = JSON.parse(source) as ChartConfiguration & { _links?: unknown };
  if (!parsed || typeof parsed !== 'object' || !parsed.type || !parsed.data) {
    throw new Error('Chart config must be a JSON object with "type" and "data".');
  }
  const look = (opts.look === 'handDrawn' ? 'classic' : opts.look) ?? 'classic';
  const skin = chartSkin(look, opts.isDark ?? true);

  const width = opts.width ?? 1000;
  const height = opts.height ?? 640;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  // Off-screen but attached so Chart.js can measure the canvas.
  const holder = document.createElement('div');
  holder.style.cssText = `position:fixed;left:-99999px;top:0;width:${width}px;height:${height}px;opacity:0;pointer-events:none;`;
  holder.appendChild(canvas);
  document.body.appendChild(holder);

  const { config, plugins, containerBg } = applyChartSkin(parsed, skin, {
    responsive: false,
    maintainAspectRatio: false,
    animation: false,
    // Pin DPR to 1 so Chart.js's backing store matches the logical canvas size.
    // Otherwise on a HiDPI display the source canvas is width*DPR × height*DPR
    // while our output canvas is width × height, and the 3-arg drawImage below
    // would copy physical pixels 1:1 — cropping to the top-left 1/DPR².
    devicePixelRatio: 1,
  });

  let chart: Chart | null = null;
  try {
    chart = new Chart(canvas, { ...config, plugins });
    // Force a synchronous draw of the (animation-free) first frame.
    chart.update('none');
    chart.render();
    // Paint the skin/background behind the chart so PNGs aren't transparent.
    const out = document.createElement('canvas');
    out.width = width;
    out.height = height;
    const ctx = out.getContext('2d')!;
    ctx.fillStyle = flattenBg(containerBg, opts.isDark ?? true);
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(canvas, 0, 0);
    return out.toDataURL('image/png');
  } finally {
    chart?.destroy();
    holder.remove();
  }
}

/** The chart skins carry a CSS gradient for containerBg; flatten to a solid fill for the PNG base. */
function flattenBg(containerBg: string | undefined, isDark: boolean): string {
  if (!containerBg) return isDark ? '#0b1220' : '#ffffff';
  // neo look uses a radial gradient bottoming out at #020617.
  if (containerBg.includes('#020617')) return '#020617';
  return isDark ? '#0b1220' : '#ffffff';
}
