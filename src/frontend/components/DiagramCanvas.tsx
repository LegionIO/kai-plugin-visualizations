import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { Chart } from 'chart.js';
import type { Engine, VizDefaults } from '../../shared/types.js';
import { MermaidRenderer } from './MermaidRenderer';
import { ChartRenderer } from './ChartRenderer';

type Props = {
  projectId: string;
  engine: Engine;
  source: string;
  defaults?: VizDefaults;
  focusNode?: string | null;
  onNavigate: (projectId: string, nodeId?: string) => void;
};

export type CanvasHandle = {
  getSvg: () => SVGSVGElement | null;
  getChart: () => Chart | null;
};

/** Pan/zoom viewport for mermaid; chart.js manages its own canvas so no transform there. */
export function DiagramCanvas({
  projectId,
  engine,
  source,
  defaults,
  focusNode,
  onNavigate,
  handleRef,
}: Props & { handleRef?: React.MutableRefObject<CanvasHandle | null> }) {
  const [scale, setScale] = useState(1);
  const [tx, setTx] = useState(0);
  const [ty, setTy] = useState(0);
  const dragRef = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const chartRef = useRef<Chart | null>(null);

  const panToRect = useCallback((rect: DOMRect) => {
    const vp = viewportRef.current?.getBoundingClientRect();
    if (!vp) return;
    const targetCx = rect.left + rect.width / 2;
    const targetCy = rect.top + rect.height / 2;
    const vpCx = vp.left + vp.width / 2;
    const vpCy = vp.top + vp.height / 2;
    setTx((t) => t + (vpCx - targetCx));
    setTy((t) => t + (vpCy - targetCy));
  }, []);

  if (handleRef) {
    handleRef.current = {
      getSvg: () => svgRef.current,
      getChart: () => chartRef.current,
    };
  }

  const reset = useCallback(() => {
    setScale(1);
    setTx(0);
    setTy(0);
  }, []);

  useEffect(() => {
    reset();
  }, [projectId, engine, reset]);

  const zoom = useCallback((delta: number) => {
    setScale((s) => Math.min(4, Math.max(0.2, s * (delta > 0 ? 0.9 : 1.1))));
  }, []);

  const onWheel = (e: React.WheelEvent) => {
    if (engine !== 'mermaid') return;
    e.preventDefault();
    zoom(e.deltaY);
  };

  const onMouseDown = (e: React.MouseEvent) => {
    if (engine !== 'mermaid' || e.button !== 0) return;
    dragRef.current = { x: e.clientX, y: e.clientY, tx, ty };
  };
  const onMouseMove = (e: React.MouseEvent) => {
    const d = dragRef.current;
    if (!d) return;
    setTx(d.tx + (e.clientX - d.x));
    setTy(d.ty + (e.clientY - d.y));
  };
  const endDrag = () => {
    dragRef.current = null;
  };

  const empty = source.trim().length === 0;

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      {engine === 'mermaid' && !empty ? (
        <div className="absolute right-3 top-3 z-10 flex gap-1 rounded-lg border border-border/60 bg-card/90 p-1 shadow-sm">
          <button
            type="button"
            title="Zoom in"
            onClick={() => zoom(-1)}
            className="rounded px-2 py-1 text-xs hover:bg-muted/60"
          >
            +
          </button>
          <button
            type="button"
            title="Zoom out"
            onClick={() => zoom(1)}
            className="rounded px-2 py-1 text-xs hover:bg-muted/60"
          >
            −
          </button>
          <button
            type="button"
            title="Reset view"
            onClick={reset}
            className="rounded px-2 py-1 text-xs hover:bg-muted/60"
          >
            ⟲
          </button>
        </div>
      ) : null}

      <div
        ref={viewportRef}
        className="relative flex-1 overflow-hidden bg-muted/20"
        onWheel={onWheel}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={endDrag}
        onMouseLeave={endDrag}
        onDoubleClick={engine === 'mermaid' ? reset : undefined}
        style={{ cursor: dragRef.current ? 'grabbing' : engine === 'mermaid' ? 'grab' : 'default' }}
      >
        {empty ? (
          <div className="flex h-full items-center justify-center p-8 text-center text-sm text-muted-foreground">
            Nothing to render yet. Send a message in the chat to generate your first diagram.
          </div>
        ) : engine === 'mermaid' ? (
          <div
            className="absolute inset-0 flex items-start justify-center p-6"
            style={{ transform: `translate(${tx}px, ${ty}px) scale(${scale})`, transformOrigin: '50% 0' }}
          >
            <MermaidRenderer
              id={projectId}
              source={source}
              look={defaults?.mermaidLook}
              curve={defaults?.mermaidCurve}
              focusNode={focusNode}
              onNavigate={onNavigate}
              onFocusRect={panToRect}
              onRendered={(el) => {
                svgRef.current = el;
              }}
            />
          </div>
        ) : (
          <ChartRenderer
            source={source}
            look={defaults?.mermaidLook}
            focusNode={focusNode}
            onNavigate={onNavigate}
            onRendered={(c) => {
              chartRef.current = c;
            }}
          />
        )}
      </div>
    </div>
  );
}
