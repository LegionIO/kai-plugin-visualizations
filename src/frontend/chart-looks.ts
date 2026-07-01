import type { Chart, Plugin, ChartType, ChartConfiguration } from 'chart.js';
import type { MermaidLook } from '../shared/types.js';

type Skin = {
  palette: string[];
  border: string[];
  font: { family: string; color: string };
  grid: string;
  axis: string;
  borderRadius?: number;
  borderWidth: number;
  tension?: number;
  pointRadius?: number;
  plugins: Plugin[];
  containerBg?: string;
};

const NEO_PALETTE = ['#38bdf8', '#a78bfa', '#f472b6', '#34d399', '#fbbf24', '#60a5fa', '#fb7185'];
const CLASSIC_LIGHT = ['#2563eb', '#dc2626', '#16a34a', '#ca8a04', '#7c3aed', '#0891b2', '#db2777'];
const CLASSIC_DARK = ['#60a5fa', '#f87171', '#4ade80', '#facc15', '#a78bfa', '#22d3ee', '#f472b6'];

function bgPlugin(fill: (ctx: CanvasRenderingContext2D, w: number, h: number) => void): Plugin {
  return {
    id: 'viz-bg',
    beforeDraw(chart: Chart) {
      const { ctx, width, height } = chart;
      ctx.save();
      fill(ctx, width, height);
      ctx.restore();
    },
  };
}

function shadowPlugin(color: string, blur: number): Plugin {
  return {
    id: 'viz-shadow',
    beforeDatasetsDraw(chart: Chart) {
      const { ctx } = chart;
      ctx.save();
      ctx.shadowColor = color;
      ctx.shadowBlur = blur;
    },
    afterDatasetsDraw(chart: Chart) {
      chart.ctx.restore();
    },
  };
}

export function chartSkin(look: MermaidLook, isDark: boolean): Skin {
  if (look === 'neo') {
    return {
      palette: NEO_PALETTE,
      border: NEO_PALETTE,
      font: { family: 'ui-sans-serif, system-ui, sans-serif', color: '#e5e7eb' },
      grid: 'rgba(56,189,248,0.12)',
      axis: '#64748b',
      borderRadius: 8,
      borderWidth: 1.5,
      tension: 0.35,
      pointRadius: 4,
      containerBg: 'radial-gradient(ellipse at 50% 0%, #0b1220 0%, #020617 70%)',
      plugins: [
        bgPlugin((ctx, w, h) => {
          const g = ctx.createRadialGradient(w / 2, 0, 0, w / 2, 0, Math.max(w, h));
          g.addColorStop(0, '#0b1220');
          g.addColorStop(0.7, '#020617');
          ctx.fillStyle = g;
          ctx.fillRect(0, 0, w, h);
        }),
        shadowPlugin('rgba(56,189,248,0.5)', 12),
      ],
    };
  }
  const palette = isDark ? CLASSIC_DARK : CLASSIC_LIGHT;
  return {
    palette,
    border: palette,
    font: { family: 'ui-sans-serif, system-ui, sans-serif', color: isDark ? '#e5e7eb' : '#1f2937' },
    grid: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)',
    axis: isDark ? '#9ca3af' : '#4b5563',
    borderRadius: 4,
    borderWidth: 1,
    tension: 0.25,
    pointRadius: 3,
    plugins: [shadowPlugin('rgba(0,0,0,0.15)', 4)],
  };
}

/** Returns semi-transparent version of a hex color for area fills. */
function alpha(hex: string, a: number): string {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!m) return hex;
  return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${a})`;
}

/**
 * Layer skin defaults under the user's config. User-supplied colors/options win.
 * Config comes from JSON.parse so it contains no functions — safe to spread.
 */
export function applyChartSkin(
  cfg: ChartConfiguration & { _links?: unknown },
  skin: Skin,
  extraOptions: Record<string, unknown>,
): { config: ChartConfiguration; plugins: Plugin[]; containerBg?: string } {
  const type = (cfg.type ?? 'bar') as ChartType;
  const isLine = type === 'line' || type === 'radar';
  const isArc = type === 'pie' || type === 'doughnut' || type === 'polarArea';

  const data = { ...(cfg.data as unknown as Record<string, unknown>) };
  const rawDatasets = Array.isArray((data as { datasets?: unknown[] }).datasets)
    ? ((data as { datasets: unknown[] }).datasets as Array<Record<string, unknown>>)
    : [];

  const datasets = rawDatasets.map((ds, i) => {
    const c = skin.palette[i % skin.palette.length];
    const b = skin.border[i % skin.border.length];
    const out: Record<string, unknown> = { ...ds };
    if (out.backgroundColor === undefined) {
      out.backgroundColor = isArc
        ? skin.palette.map((p) => alpha(p, 0.85))
        : isLine
          ? alpha(c, 0.18)
          : alpha(c, 0.85);
    }
    if (out.borderColor === undefined) {
      out.borderColor = isArc ? skin.border.map((p) => p) : b;
    }
    if (out.borderWidth === undefined) out.borderWidth = skin.borderWidth;
    if (skin.borderRadius !== undefined && out.borderRadius === undefined && type === 'bar') {
      out.borderRadius = skin.borderRadius;
    }
    if (isLine) {
      if (out.tension === undefined && skin.tension !== undefined) out.tension = skin.tension;
      if (out.pointRadius === undefined && skin.pointRadius !== undefined) out.pointRadius = skin.pointRadius;
      if (out.pointBackgroundColor === undefined) out.pointBackgroundColor = c;
      if (out.fill === undefined) out.fill = true;
    }
    return out;
  });

  const scales =
    !isArc
      ? {
          x: {
            grid: { color: skin.grid },
            ticks: { color: skin.font.color },
            border: { color: skin.axis },
          },
          y: {
            grid: { color: skin.grid },
            ticks: { color: skin.font.color },
            border: { color: skin.axis },
          },
        }
      : undefined;

  const options = deepMerge(
    {
      font: { family: skin.font.family },
      color: skin.font.color,
      plugins: {
        legend: { labels: { color: skin.font.color, font: { family: skin.font.family } } },
        tooltip: {
          backgroundColor: 'rgba(2,6,23,0.9)',
          titleColor: '#e5e7eb',
          bodyColor: '#cbd5e1',
          borderColor: skin.border[0],
          borderWidth: 1,
        },
      },
      ...(scales ? { scales } : {}),
    },
    (cfg.options as Record<string, unknown>) ?? {},
  );

  return {
    config: {
      type,
      data: { ...data, datasets } as never,
      options: deepMerge(options, extraOptions) as never,
    },
    plugins: skin.plugins,
    containerBg: skin.containerBg,
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function deepMerge(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (isPlainObject(v) && isPlainObject(out[k])) {
      out[k] = deepMerge(out[k] as Record<string, unknown>, v);
    } else {
      out[k] = v;
    }
  }
  return out;
}
