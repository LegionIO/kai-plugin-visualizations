import React, { useState, useEffect } from 'react';
import { useModelCatalog, type PluginComponentProps } from '../hooks';
import type { VizDefaults, VizState, Engine, MermaidLook, MermaidCurve } from '../../shared/types.js';
import { ENGINES, DEFAULT_MAX_HISTORY_MESSAGES } from '../../shared/constants.js';

type SaveState = 'idle' | 'saving' | 'saved';

export function SettingsView({ onAction, pluginState, pluginConfig }: PluginComponentProps<VizState>) {
  const stateDefaults = (pluginState as Partial<VizState> | undefined)?.defaults;
  const cfgDefaults = ((pluginConfig ?? {}) as { defaults?: VizDefaults }).defaults;
  const defaults: VizDefaults = stateDefaults ?? cfgDefaults ?? {};

  const { models, defaultKey } = useModelCatalog();

  const [engine, setEngine] = useState<Engine>(defaults.engine ?? 'mermaid');
  const [modelOverride, setModelOverride] = useState<string>(defaults.modelOverride ?? '');
  const [maxHistory, setMaxHistory] = useState(defaults.maxHistoryMessages ?? DEFAULT_MAX_HISTORY_MESSAGES);
  const [look, setLook] = useState<MermaidLook>(defaults.mermaidLook ?? 'classic');
  const [curve, setCurve] = useState<MermaidCurve>(defaults.mermaidCurve ?? 'basis');
  const [saveState, setSaveState] = useState<SaveState>('idle');

  // Sync local form when persisted defaults change (round-trip after save, or external edit).
  useEffect(() => {
    setEngine(defaults.engine ?? 'mermaid');
    setModelOverride(defaults.modelOverride ?? '');
    setMaxHistory(defaults.maxHistoryMessages ?? DEFAULT_MAX_HISTORY_MESSAGES);
    setLook(defaults.mermaidLook ?? 'classic');
    setCurve(defaults.mermaidCurve ?? 'basis');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    defaults.engine,
    defaults.modelOverride,
    defaults.maxHistoryMessages,
    defaults.mermaidLook,
    defaults.mermaidCurve,
  ]);

  const dirty =
    engine !== (defaults.engine ?? 'mermaid') ||
    modelOverride !== (defaults.modelOverride ?? '') ||
    maxHistory !== (defaults.maxHistoryMessages ?? DEFAULT_MAX_HISTORY_MESSAGES) ||
    look !== (defaults.mermaidLook ?? 'classic') ||
    curve !== (defaults.mermaidCurve ?? 'basis');

  useEffect(() => {
    if (dirty && saveState === 'saved') setSaveState('idle');
  }, [dirty, saveState]);

  const save = () => {
    setSaveState('saving');
    onAction('set-defaults', {
      engine,
      modelOverride: modelOverride || undefined,
      maxHistoryMessages: maxHistory,
      mermaidLook: look,
      mermaidCurve: curve,
    });
    setSaveState('saved');
    setTimeout(() => setSaveState((s) => (s === 'saved' ? 'idle' : s)), 2500);
  };

  const defaultModelLabel =
    models.find((m) => m.key === defaultKey)?.displayName ?? defaultKey ?? 'Kai default';

  return (
    <div className="space-y-5">
      <fieldset className="space-y-3 rounded-lg border border-border/50 p-4">
        <legend className="px-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          Defaults
        </legend>

        <label className="block space-y-1">
          <span className="text-xs font-medium">Default engine for new projects</span>
          <select
            value={engine}
            onChange={(e) => setEngine(e.target.value as Engine)}
            className="w-full rounded-xl border border-border/70 bg-card/80 px-2.5 py-1.5 text-xs"
          >
            {ENGINES.map((e) => (
              <option key={e} value={e}>
                {e}
              </option>
            ))}
          </select>
        </label>

        <label className="block space-y-1">
          <span className="text-xs font-medium">Model</span>
          <select
            value={modelOverride}
            onChange={(e) => setModelOverride(e.target.value)}
            className="w-full rounded-xl border border-border/70 bg-card/80 px-2.5 py-1.5 text-xs"
          >
            <option value="">Use Kai default ({defaultModelLabel})</option>
            {models.map((m) => (
              <option key={m.key} value={m.key}>
                {m.displayName}
              </option>
            ))}
            {modelOverride && !models.some((m) => m.key === modelOverride) ? (
              <option value={modelOverride}>{modelOverride} (unknown)</option>
            ) : null}
          </select>
          <span className="text-[10px] text-muted-foreground">
            Model used for the diagram agent's tool loop. Leave on default to follow Kai's global
            model.
          </span>
        </label>

        <label className="block space-y-1">
          <span className="text-xs font-medium">Chat history sent to AI</span>
          <input
            type="number"
            min={4}
            max={200}
            value={maxHistory}
            onChange={(e) => setMaxHistory(Number(e.target.value))}
            className="w-full rounded-xl border border-border/70 bg-card/80 px-2.5 py-1.5 text-xs"
          />
        </label>
      </fieldset>

      <fieldset className="space-y-3 rounded-lg border border-border/50 p-4">
        <legend className="px-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          Appearance
        </legend>

        <label className="block space-y-1">
          <span className="text-xs font-medium">Look</span>
          <select
            value={look}
            onChange={(e) => setLook(e.target.value as MermaidLook)}
            className="w-full rounded-xl border border-border/70 bg-card/80 px-2.5 py-1.5 text-xs"
          >
            <option value="classic">Classic (crisp shapes)</option>
            <option value="neo">Neo (dark, gradients, neon glow)</option>
            <option value="handDrawn">Hand-drawn (sketch — mermaid only)</option>
          </select>
          <span className="text-[10px] text-muted-foreground">
            Applies to both Mermaid and Chart.js renders. Nodes/bars get subtle shadows and rounded
            corners; Neo adds a dark gradient backdrop with cyan/violet glow.
          </span>
        </label>

        <label className="block space-y-1">
          <span className="text-xs font-medium">Mermaid edge style</span>
          <select
            value={curve}
            onChange={(e) => setCurve(e.target.value as MermaidCurve)}
            className="w-full rounded-xl border border-border/70 bg-card/80 px-2.5 py-1.5 text-xs"
          >
            <option value="basis">Curved (basis)</option>
            <option value="natural">Curved (natural)</option>
            <option value="linear">Straight</option>
            <option value="step">Stepped</option>
          </select>
        </label>
      </fieldset>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={!dirty && saveState !== 'saving'}
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          {saveState === 'saved' ? '✓ Saved' : dirty ? 'Save' : 'Saved'}
        </button>
        {dirty ? (
          <span className="text-[11px] text-muted-foreground">Unsaved changes</span>
        ) : saveState === 'saved' ? (
          <span className="text-[11px] text-emerald-500">Settings applied</span>
        ) : null}
      </div>
    </div>
  );
}
