import React, { useEffect, useMemo, useState } from 'react';
import type { Engine, Fragment } from '../../shared/types.js';
import { ENGINES } from '../../shared/constants.js';

type Props = {
  engine: Engine;
  fragments: Fragment[];
  disabled?: boolean;
  onSaveFragment: (fragmentId: string, engine: Engine, source: string) => void;
  onCreateFragment: (name: string) => void;
  onDeleteFragment: (fragmentId: string) => void;
  onRenameFragment: (fragmentId: string, name: string) => void;
  onReorder: (order: string[]) => void;
};

export function SourceEditor({
  engine,
  fragments,
  disabled,
  onSaveFragment,
  onCreateFragment,
  onDeleteFragment,
  onRenameFragment,
  onReorder,
}: Props) {
  const [selectedId, setSelectedId] = useState<string>(fragments[0]?.id ?? '');
  const selected = useMemo(
    () => fragments.find((f) => f.id === selectedId) ?? fragments[0],
    [fragments, selectedId],
  );

  const [localEngine, setLocalEngine] = useState<Engine>(engine);
  const [localSource, setLocalSource] = useState(selected?.source ?? '');
  const [upstream, setUpstream] = useState({ engine, source: selected?.source ?? '' });
  const [renaming, setRenaming] = useState(false);

  const dirty = localEngine !== upstream.engine || localSource !== upstream.source;
  const upstreamChanged = engine !== upstream.engine || (selected?.source ?? '') !== upstream.source;

  useEffect(() => {
    if (!fragments.some((f) => f.id === selectedId)) {
      setSelectedId(fragments[0]?.id ?? '');
    }
  }, [fragments, selectedId]);

  useEffect(() => {
    if (dirty) return;
    const src = selected?.source ?? '';
    setLocalEngine(engine);
    setLocalSource(src);
    setUpstream({ engine, source: src });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, selected?.id, selected?.source]);

  const acceptUpstream = () => {
    const src = selected?.source ?? '';
    setLocalEngine(engine);
    setLocalSource(src);
    setUpstream({ engine, source: src });
  };

  const move = (dir: -1 | 1) => {
    const idx = fragments.findIndex((f) => f.id === selectedId);
    const j = idx + dir;
    if (idx < 0 || j < 0 || j >= fragments.length) return;
    const order = fragments.map((f) => f.id);
    [order[idx], order[j]] = [order[j], order[idx]];
    onReorder(order);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Fragment tabs */}
      <div className="flex items-center gap-1 overflow-x-auto border-b border-border/50 px-3 py-1.5">
        {fragments.map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => {
              if (dirty && f.id !== selectedId && !confirm('Discard unsaved changes?')) return;
              setSelectedId(f.id);
              setLocalSource(f.source);
              setUpstream({ engine, source: f.source });
              setRenaming(false);
            }}
            onDoubleClick={() => f.id === selectedId && setRenaming(true)}
            className={`shrink-0 rounded-lg px-2.5 py-1 text-xs ${
              f.id === selectedId
                ? 'bg-primary/15 font-medium text-primary'
                : 'text-muted-foreground hover:bg-muted/40'
            }`}
            title={`${f.source.split('\n').length} lines`}
          >
            {f.name}
          </button>
        ))}
        <button
          type="button"
          onClick={() => {
            const name = prompt('Fragment name (e.g. "styles", "edges"):');
            if (name?.trim()) onCreateFragment(name.trim());
          }}
          className="shrink-0 rounded-lg px-2 py-1 text-xs text-muted-foreground hover:bg-muted/40"
          title="Add fragment"
        >
          +
        </button>
      </div>

      {/* Toolbar */}
      <div className="flex items-center justify-between gap-3 border-b border-border/50 px-4 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-xs text-muted-foreground">Engine</span>
          <select
            value={localEngine}
            onChange={(e) => setLocalEngine(e.target.value as Engine)}
            className="rounded-lg border border-border/70 bg-card/80 px-2 py-1 text-xs"
          >
            {ENGINES.map((e) => (
              <option key={e} value={e}>
                {e}
              </option>
            ))}
          </select>
          {selected && renaming ? (
            <input
              autoFocus
              defaultValue={selected.name}
              onBlur={(e) => {
                const v = e.target.value.trim();
                if (v && v !== selected.name) onRenameFragment(selected.id, v);
                setRenaming(false);
              }}
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
              className="rounded border border-border/70 bg-card/80 px-1.5 py-0.5 text-xs"
              style={{ width: '120px' }}
            />
          ) : selected ? (
            <span className="truncate text-xs text-muted-foreground" title="Double-click tab to rename">
              {selected.name}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            title="Move fragment left"
            disabled={disabled || fragments.findIndex((f) => f.id === selectedId) <= 0}
            onClick={() => move(-1)}
            className="rounded px-1.5 py-1 text-xs hover:bg-muted/50 disabled:opacity-30"
          >
            ◀
          </button>
          <button
            type="button"
            title="Move fragment right"
            disabled={
              disabled || fragments.findIndex((f) => f.id === selectedId) >= fragments.length - 1
            }
            onClick={() => move(1)}
            className="rounded px-1.5 py-1 text-xs hover:bg-muted/50 disabled:opacity-30"
          >
            ▶
          </button>
          <button
            type="button"
            title="Delete fragment"
            disabled={disabled || fragments.length <= 1}
            onClick={() => {
              if (selected && confirm(`Delete fragment "${selected.name}"?`)) {
                onDeleteFragment(selected.id);
              }
            }}
            className="rounded px-1.5 py-1 text-xs text-muted-foreground hover:bg-muted/50 disabled:opacity-30"
          >
            ✕
          </button>
          <div className="mx-1 h-4 w-px bg-border/60" />
          {dirty ? (
            <button
              type="button"
              onClick={acceptUpstream}
              className="rounded-lg px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted/50"
            >
              Discard
            </button>
          ) : null}
          <button
            type="button"
            disabled={!dirty || disabled || !selected}
            title={disabled ? 'Wait for generation to finish' : undefined}
            onClick={() => {
              if (!selected) return;
              onSaveFragment(selected.id, localEngine, localSource);
              setUpstream({ engine: localEngine, source: localSource });
            }}
            className="rounded-lg bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-40"
          >
            Save revision
          </button>
        </div>
      </div>

      {dirty && upstreamChanged ? (
        <div className="flex items-center justify-between gap-2 border-b border-amber-500/40 bg-amber-500/10 px-4 py-1.5 text-[11px]">
          <span>This fragment changed elsewhere while you were editing. Your draft is preserved.</span>
          <button
            type="button"
            onClick={acceptUpstream}
            className="rounded border border-amber-500/60 px-2 py-0.5 hover:bg-amber-500/20"
          >
            Load latest
          </button>
        </div>
      ) : null}

      <textarea
        value={localSource}
        onChange={(e) => setLocalSource(e.target.value)}
        spellCheck={false}
        placeholder={
          localEngine === 'mermaid'
            ? 'graph TD\n  A[Client] --> B[Server]'
            : '{\n  "type": "bar",\n  "data": { "labels": [...], "datasets": [...] }\n}'
        }
        className="flex-1 resize-none bg-background p-4 font-mono text-xs outline-none"
      />
    </div>
  );
}
