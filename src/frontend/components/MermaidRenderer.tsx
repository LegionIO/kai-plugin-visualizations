import React, { useEffect, useRef, useState } from 'react';
import mermaid from 'mermaid';
import DOMPurify from 'dompurify';
import { useDarkMode, parseVizHref } from '../hooks';
import type { MermaidCurve, MermaidLook } from '../../shared/types.js';

type Props = {
  id: string;
  source: string;
  look?: MermaidLook;
  curve?: MermaidCurve;
  focusNode?: string | null;
  onNavigate: (projectId: string, nodeId?: string) => void;
  onRendered?: (svgEl: SVGSVGElement | null) => void;
  /** Called with the focused node's viewport-relative center so the parent can pan to it. */
  onFocusRect?: (rect: DOMRect) => void;
};

// DOMPurify strips unknown URI schemes before afterSanitizeAttributes runs, so stash
// viz:// hrefs into a data attr first, then restore (and drop everything else).
DOMPurify.addHook('beforeSanitizeAttributes', (node) => {
  if (!(node instanceof Element)) return;
  const href = node.getAttribute('href') ?? node.getAttribute('xlink:href');
  if (href && href.startsWith('viz://')) node.setAttribute('data-viz-href', href);
});
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (!(node instanceof Element)) return;
  node.removeAttribute('xlink:href');
  const stashed = node.getAttribute('data-viz-href');
  node.removeAttribute('data-viz-href');
  if (stashed && stashed.startsWith('viz://')) {
    node.setAttribute('href', stashed);
  } else if (node.hasAttribute('href')) {
    node.removeAttribute('href');
    node.removeAttribute('target');
  }
});

const BASE_THEME_CSS = `
  .node rect, .node polygon, .node circle, .node ellipse, .node path, .cluster rect {
    filter: drop-shadow(0 2px 4px rgba(0,0,0,0.25));
  }
  .cluster rect { rx: 8px; }
  a[href^="viz://"] { cursor: pointer; }
  a[href^="viz://"]:hover .label-container,
  a[href^="viz://"]:hover rect { stroke-width: 2.5px; }
`;

const NEO_THEME_CSS = `
  .node rect, .node polygon, .node circle, .node ellipse, .node path {
    fill: url(#neo-node-gradient);
    rx: 10px;
    stroke-width: 1.5px;
    filter: drop-shadow(0 0 6px rgba(56,189,248,0.35)) drop-shadow(0 4px 12px rgba(0,0,0,0.5));
  }
  .node rect[style*="fill:"], .node polygon[style*="fill:"], .node path[style*="fill:"] {
    /* honor per-node style directives from the source over the gradient */
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
  a[href^="viz://"] { cursor: pointer; }
  a[href^="viz://"] rect, a[href^="viz://"] polygon, a[href^="viz://"] path {
    stroke: #a78bfa;
    filter: drop-shadow(0 0 8px rgba(167,139,250,0.6)) drop-shadow(0 4px 12px rgba(0,0,0,0.5));
  }
  a[href^="viz://"]:hover rect, a[href^="viz://"]:hover polygon, a[href^="viz://"]:hover path {
    stroke-width: 3px;
    filter: drop-shadow(0 0 14px rgba(167,139,250,0.9)) drop-shadow(0 4px 12px rgba(0,0,0,0.5));
  }
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

type Skin = {
  mermaidLook: 'classic' | 'handDrawn';
  theme: 'base' | 'dark' | 'default';
  themeCSS: string;
  themeVariables: Record<string, unknown>;
  canvasBg?: string;
  injectDefs?: string;
};

function themeFor(look: MermaidLook, isDark: boolean): Skin {
  if (look === 'neo') {
    return {
      mermaidLook: 'classic',
      theme: 'base',
      themeCSS: NEO_THEME_CSS,
      themeVariables: NEO_THEME_VARS,
      canvasBg: 'radial-gradient(ellipse at 50% 0%, #0b1220 0%, #020617 70%)',
      injectDefs: NEO_DEFS,
    };
  }
  return {
    mermaidLook: look,
    theme: isDark ? 'dark' : 'default',
    themeCSS: BASE_THEME_CSS,
    themeVariables: { fontSize: '14px', primaryBorderColor: isDark ? '#4b5563' : '#94a3b8' },
  };
}

function sanitizeSvg(svg: string): string {
  const out = DOMPurify.sanitize(svg, {
    ADD_TAGS: ['foreignObject', 'style'],
    ADD_ATTR: [
      'transform',
      'dominant-baseline',
      'text-anchor',
      'stroke-dasharray',
      'stroke-width',
      'marker-end',
      'marker-start',
      'dx',
      'dy',
      'x',
      'y',
      'rx',
      'ry',
      'data-viz-href',
    ],
  });
  const removed = (DOMPurify as { removed?: unknown[] }).removed;
  if (removed && removed.length > 0) {
    console.warn('[viz] DOMPurify stripped from mermaid output:', removed);
  }
  return out;
}

/** Mermaid emits flowchart node ids like `flowchart-<NodeId>-<n>`. Match exactly, not by substring. */
function findNodeElement(root: HTMLElement, nodeId: string): SVGGraphicsElement | null {
  const esc = CSS.escape(nodeId);
  const exact =
    root.querySelector<SVGGraphicsElement>(`g[data-id="${esc}"]`) ??
    root.querySelector<SVGGraphicsElement>(`g[id="${esc}"]`) ??
    root.querySelector<SVGGraphicsElement>(`[id$="-${esc}"]`);
  if (exact) return exact;
  const reEsc = nodeId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(^|-)${reEsc}(-\\d+)?$`);
  const candidates = root.querySelectorAll<SVGGraphicsElement>('g.node, g[id]');
  for (const el of Array.from(candidates)) {
    const id = el.getAttribute('id') ?? '';
    if (id === nodeId || pattern.test(id)) return el;
  }
  return null;
}

export function MermaidRenderer({
  id,
  source,
  look = 'classic',
  curve = 'basis',
  focusNode,
  onNavigate,
  onRendered,
  onFocusRect,
}: Props) {
  const isDark = useDarkMode();
  const containerRef = useRef<HTMLDivElement>(null);
  const [svg, setSvg] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const renderedRef = useRef(onRendered);
  renderedRef.current = onRendered;
  const focusRectRef = useRef(onFocusRect);
  focusRectRef.current = onFocusRect;

  const skin = themeFor(look, isDark);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    renderedRef.current?.(null);

    mermaid.initialize({
      startOnLoad: false,
      // 'loose' lets click-href render as anchors; output is sanitized below.
      securityLevel: 'loose',
      theme: skin.theme,
      look: skin.mermaidLook,
      fontFamily: 'ui-sans-serif, system-ui, sans-serif',
      themeCSS: skin.themeCSS,
      themeVariables: skin.themeVariables,
      // htmlLabels:false → SVG <text>/<tspan> labels, which survive DOMPurify
      // (foreignObject HTML content does not).
      htmlLabels: false,
      flowchart: {
        htmlLabels: false,
        useMaxWidth: false,
        curve,
        padding: 14,
        nodeSpacing: 55,
        rankSpacing: 65,
      },
      class: { htmlLabels: false },
      er: { useMaxWidth: false },
      sequence: { useMaxWidth: false },
    });

    const renderId = `viz-${id}-${Math.random().toString(36).slice(2, 8)}`;
    mermaid
      .render(renderId, source)
      .then(({ svg: out }) => {
        if (cancelled) return;
        let final = out;
        if (skin.injectDefs) {
          final = final.replace(/(<svg[^>]*>)/, `$1<defs>${skin.injectDefs}</defs>`);
        }
        setSvg(sanitizeSvg(final));
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setSvg('');
        setError(e instanceof Error ? e.message : String(e));
      });

    return () => {
      cancelled = true;
      const orphan = document.getElementById(renderId);
      if (orphan) orphan.remove();
    };
  }, [id, source, isDark, look, curve]);

  useEffect(() => {
    const svgEl = containerRef.current?.querySelector('svg') as SVGSVGElement | null;
    renderedRef.current?.(svgEl);
  }, [svg]);

  useEffect(() => {
    const root = containerRef.current;
    if (!root || !svg) return;

    root.querySelectorAll<SVGGraphicsElement>('.viz-focused').forEach((el) => {
      el.classList.remove('viz-focused');
      el.style.filter = '';
    });

    if (!focusNode) return;
    const target = findNodeElement(root, focusNode);
    if (!target) return;

    target.classList.add('viz-focused');
    target.style.filter = 'drop-shadow(0 0 10px rgba(59,130,246,0.9))';
    focusRectRef.current?.(target.getBoundingClientRect());
  }, [svg, focusNode]);

  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const anchor = (e.target as Element).closest('a');
    if (!anchor) return;
    const href = anchor.getAttribute('href') ?? anchor.getAttribute('xlink:href');
    if (!href) return;
    const parsed = parseVizHref(href);
    if (!parsed) {
      e.preventDefault();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    onNavigate(parsed.projectId, parsed.nodeId);
  };

  if (error) {
    return (
      <div className="m-4 rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm">
        <div className="font-medium text-destructive">Mermaid syntax error</div>
        <pre className="mt-2 whitespace-pre-wrap text-xs text-destructive/90">{error}</pre>
        <div className="mt-2 text-xs text-muted-foreground">
          Ask the agent to fix it, or edit the source directly.
        </div>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      onClick={handleClick}
      className="mermaid-render"
      style={{
        minHeight: '100%',
        minWidth: '100%',
        background: skin.canvasBg,
        borderRadius: skin.canvasBg ? '12px' : undefined,
        padding: skin.canvasBg ? '16px' : undefined,
      }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
