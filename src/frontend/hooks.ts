import { useState, useEffect, useRef } from 'react';

export type PluginComponentProps<
  TState = Record<string, unknown>,
  TConfig = Record<string, unknown>,
> = {
  pluginName: string;
  pluginState?: TState;
  pluginConfig?: TConfig;
  setPluginConfig?: (path: string, value: unknown) => Promise<void>;
  onAction: (action: string, data?: unknown) => void;
  onClose?: () => void;
  props?: Record<string, unknown>;
};

export function useDarkMode(): boolean {
  const [isDark, setIsDark] = useState(() => {
    if (typeof document !== 'undefined') {
      return document.documentElement.classList.contains('dark');
    }
    if (typeof window !== 'undefined') {
      return window.matchMedia('(prefers-color-scheme: dark)').matches;
    }
    return false;
  });

  useEffect(() => {
    const observer = new MutationObserver(() => {
      setIsDark(document.documentElement.classList.contains('dark'));
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => {
      if (
        !document.documentElement.classList.contains('dark') &&
        !document.documentElement.classList.contains('light')
      ) {
        setIsDark(mql.matches);
      }
    };
    mql.addEventListener('change', handler);

    return () => {
      observer.disconnect();
      mql.removeEventListener('change', handler);
    };
  }, []);

  return isDark;
}

/**
 * Fill the host panel: measure from this element's top to the bottom of the
 * nearest scrollable ancestor and return that as an explicit pixel height.
 * Mirrors kai-plugin-bluebubbles so the panel isn't cut short.
 */
export function usePanelHeight(min = 480): [React.RefObject<HTMLDivElement | null>, number | null] {
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | null>(null);

  useEffect(() => {
    const panel = ref.current;
    if (!panel || typeof window === 'undefined') return;

    let parent = panel.parentElement;
    while (parent) {
      const oy = window.getComputedStyle(parent).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && parent.clientHeight > 0) break;
      parent = parent.parentElement;
    }

    const measure = () => {
      const rect = panel.getBoundingClientRect();
      const pr = parent?.getBoundingClientRect();
      const ps = parent ? window.getComputedStyle(parent) : null;
      const bottom = pr?.bottom ?? window.innerHeight;
      const pad = ps ? Number.parseFloat(ps.paddingBottom) || 0 : 0;
      setHeight(Math.max(min, Math.floor(bottom - rect.top - pad)));
    };

    measure();
    window.addEventListener('resize', measure);
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(panel);
    if (parent) ro?.observe(parent);

    return () => {
      window.removeEventListener('resize', measure);
      ro?.disconnect();
    };
  }, [min]);

  return [ref, height];
}

export type ModelInfo = { key: string; displayName: string };

export function useModelCatalog(): { models: ModelInfo[]; defaultKey: string | null } {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [defaultKey, setDefaultKey] = useState<string | null>(null);
  useEffect(() => {
    const app = (globalThis as { window?: { app?: { modelCatalog?: () => Promise<unknown> } } }).window
      ?.app;
    app
      ?.modelCatalog?.()
      .then((data) => {
        const d = data as { models?: ModelInfo[]; defaultKey?: string };
        setModels(Array.isArray(d?.models) ? d.models : []);
        setDefaultKey(d?.defaultKey ?? null);
      })
      .catch(() => {});
  }, []);
  return { models, defaultKey };
}

/** Parse viz://<projectId>[#<nodeId>] into its parts. Returns null if not a viz link. */
export function parseVizHref(href: string): { projectId: string; nodeId?: string } | null {
  if (!href.startsWith('viz://')) return null;
  const rest = href.slice('viz://'.length);
  const hashIdx = rest.indexOf('#');
  if (hashIdx === -1) return { projectId: rest };
  const projectId = rest.slice(0, hashIdx);
  const nodeId = rest.slice(hashIdx + 1) || undefined;
  return { projectId, nodeId };
}
