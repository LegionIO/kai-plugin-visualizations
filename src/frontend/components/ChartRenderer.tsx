import React, { useEffect, useRef, useState } from 'react';
import { Chart } from 'chart.js/auto';
import type { ChartConfiguration } from 'chart.js';
import { parseVizHref, useDarkMode } from '../hooks';
import { chartSkin, applyChartSkin } from '../chart-looks';
import type { MermaidLook } from '../../shared/types.js';

type Props = {
  source: string;
  look?: MermaidLook;
  focusNode?: string | null;
  onNavigate: (projectId: string, nodeId?: string) => void;
  onRendered?: (chart: Chart | null) => void;
};

export function ChartRenderer({ source, look = 'classic', focusNode, onNavigate, onRendered }: Props) {
  const isDark = useDarkMode();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<Chart | null>(null);
  const linksRef = useRef<Record<string, string>>({});
  const navigateRef = useRef(onNavigate);
  navigateRef.current = onNavigate;
  const renderedRef = useRef(onRendered);
  renderedRef.current = onRendered;
  const [error, setError] = useState<string | null>(null);
  const [containerBg, setContainerBg] = useState<string | undefined>();

  useEffect(() => {
    setError(null);
    if (chartRef.current) {
      chartRef.current.destroy();
      chartRef.current = null;
    }
    renderedRef.current?.(null);

    // Source is JSON.parsed → pure data (no functions survive), so no DOM
    // sanitization is needed; Chart.js draws to a canvas we own.
    let cfg: ChartConfiguration & { _links?: Record<string, string> };
    try {
      cfg = JSON.parse(source);
    } catch (e) {
      setError(`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    if (!cfg || typeof cfg !== 'object' || !cfg.type || !cfg.data) {
      setError('Chart config must be an object with "type" and "data".');
      return;
    }
    linksRef.current = cfg._links ?? {};

    const canvas = canvasRef.current;
    if (!canvas) return;

    const skin = chartSkin(look === 'handDrawn' ? 'classic' : look, isDark);
    setContainerBg(skin.containerBg);

    const { config, plugins } = applyChartSkin(cfg, skin, {
      responsive: true,
      maintainAspectRatio: false,
      onClick: (_evt: unknown, elements: Array<{ datasetIndex: number; index: number }>) => {
        if (!elements.length) return;
        const { datasetIndex, index } = elements[0];
        const key = `${datasetIndex}.${index}`;
        const href = linksRef.current[key];
        if (!href) return;
        const parsed = parseVizHref(href);
        if (!parsed) return;
        navigateRef.current(parsed.projectId, parsed.nodeId);
      },
    });

    try {
      chartRef.current = new Chart(canvas, { ...config, plugins });
      renderedRef.current?.(chartRef.current);
    } catch (e) {
      Chart.getChart(canvas)?.destroy();
      chartRef.current = null;
      setError(e instanceof Error ? e.message : String(e));
    }

    return () => {
      chartRef.current?.destroy();
      chartRef.current = null;
      renderedRef.current?.(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, look, isDark]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    if (!focusNode) {
      chart.setActiveElements([]);
      chart.update();
      return;
    }
    const [dsStr, idxStr] = focusNode.split('.');
    const ds = Number(dsStr);
    const idx = Number(idxStr);
    if (Number.isNaN(ds) || Number.isNaN(idx)) return;
    try {
      chart.setActiveElements([{ datasetIndex: ds, index: idx }]);
      chart.update();
    } catch {
      /* out of range */
    }
  }, [focusNode, source, look, isDark]);

  return (
    <div
      className="relative h-full w-full p-4"
      style={{ background: containerBg, borderRadius: containerBg ? '12px' : undefined }}
    >
      <canvas ref={canvasRef} className={error ? 'hidden' : ''} />
      {error ? (
        <div className="absolute inset-4 overflow-auto rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm">
          <div className="font-medium text-destructive">Chart config error</div>
          <pre className="mt-2 whitespace-pre-wrap text-xs text-destructive/90">{error}</pre>
        </div>
      ) : null}
    </div>
  );
}
