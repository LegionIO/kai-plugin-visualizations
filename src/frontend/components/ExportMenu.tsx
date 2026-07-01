import React, { useState } from 'react';
import type { Engine } from '../../shared/types.js';
import type { CanvasHandle } from './DiagramCanvas';

type Props = {
  name: string;
  engine: Engine;
  source: string;
  canvasRef: React.MutableRefObject<CanvasHandle | null>;
  previewMounted: boolean;
};

function download(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function slug(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'diagram';
}

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

async function svgToPng(svgEl: SVGSVGElement, scale = 2): Promise<Blob> {
  const clone = svgEl.cloneNode(true) as SVGSVGElement;
  const { w: iw, h: ih } = intrinsicSize(svgEl);
  const w = Math.max(1, Math.round(iw));
  const h = Math.max(1, Math.round(ih));
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
    canvas.width = w * scale;
    canvas.height = h * scale;
    const ctx = canvas.getContext('2d')!;
    ctx.scale(scale, scale);
    ctx.drawImage(img, 0, 0);
    return await new Promise<Blob>((res, rej) =>
      canvas.toBlob((b) => (b ? res(b) : rej(new Error('toBlob failed'))), 'image/png'),
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function ExportMenu({ name, engine, source, canvasRef, previewMounted }: Props) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const base = slug(name);

  const doExportSvg = () => {
    const svg = canvasRef.current?.getSvg();
    if (!svg) return;
    const xml = new XMLSerializer().serializeToString(svg);
    download(`${base}.svg`, new Blob([xml], { type: 'image/svg+xml' }));
    setOpen(false);
  };

  const doExportPng = async () => {
    setOpen(false);
    try {
      if (engine === 'mermaid') {
        const svg = canvasRef.current?.getSvg();
        if (!svg) throw new Error('Preview not rendered yet.');
        const blob = await svgToPng(svg);
        download(`${base}.png`, blob);
      } else {
        const chart = canvasRef.current?.getChart();
        if (!chart) throw new Error('Chart not rendered yet.');
        const dataUrl = chart.toBase64Image('image/png', 1);
        const bin = atob(dataUrl.split(',')[1]);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        download(`${base}.png`, new Blob([bytes], { type: 'image/png' }));
      }
    } catch (e) {
      console.error('[viz] PNG export failed', e);
      alert(`PNG export failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const doExportSource = () => {
    const ext = engine === 'mermaid' ? 'mmd' : 'chart.json';
    const type = engine === 'mermaid' ? 'text/plain' : 'application/json';
    download(`${base}.${ext}`, new Blob([source], { type }));
    setOpen(false);
  };

  const doCopySource = async () => {
    await navigator.clipboard.writeText(source);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="rounded-lg border border-border/70 bg-card/80 px-2.5 py-1 text-xs hover:bg-muted/50"
      >
        Export ▾
      </button>
      {open ? (
        <div
          className="absolute right-0 z-20 mt-1 overflow-hidden rounded-lg border border-border/60 bg-card shadow-lg"
          style={{ width: '176px' }}
          onMouseLeave={() => setOpen(false)}
        >
          {engine === 'mermaid' ? (
            <button
              type="button"
              onClick={doExportSvg}
              disabled={!previewMounted}
              title={previewMounted ? undefined : 'Switch to Preview tab to export image'}
              className="block w-full px-3 py-2 text-left text-xs hover:bg-muted/50 disabled:cursor-not-allowed disabled:opacity-40"
            >
              SVG
            </button>
          ) : null}
          <button
            type="button"
            onClick={doExportPng}
            disabled={!previewMounted}
            title={previewMounted ? undefined : 'Switch to Preview tab to export image'}
            className="block w-full px-3 py-2 text-left text-xs hover:bg-muted/50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            PNG
          </button>
          <button
            type="button"
            onClick={doExportSource}
            className="block w-full px-3 py-2 text-left text-xs hover:bg-muted/50"
          >
            Source ({engine === 'mermaid' ? '.mmd' : '.json'})
          </button>
          <button
            type="button"
            onClick={doCopySource}
            className="block w-full px-3 py-2 text-left text-xs hover:bg-muted/50"
          >
            {copied ? '✓ Copied' : 'Copy source'}
          </button>
        </div>
      ) : null}
    </div>
  );
}
