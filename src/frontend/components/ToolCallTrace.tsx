import React, { useState } from 'react';
import type { ToolCallSummary } from '../../shared/types.js';

const VERB: Record<string, string> = {
  viz_frag_list: 'list',
  viz_frag_read: 'read',
  viz_frag_grep: 'grep',
  viz_frag_write: 'write',
  viz_frag_patch: 'patch',
  viz_frag_create: 'create',
  viz_frag_delete: 'delete',
  viz_frag_rename: 'rename',
  viz_frag_set_engine: 'engine',
  viz_frag_validate: 'validate',
};

function label(c: ToolCallSummary): string {
  const verb = VERB[c.toolName] ?? c.toolName;
  const a = c.args ?? {};
  if (typeof a.name === 'string') return `${verb} ${a.name}`;
  if (typeof a.pattern === 'string') return `${verb} "${a.pattern}"`;
  if (typeof a.engine === 'string') return `${verb} → ${a.engine}`;
  return verb;
}

export function ToolCallTrace({ calls }: { calls: ToolCallSummary[] }) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);
  if (calls.length === 0) return null;

  const failed = calls.filter((c) => !c.ok).length;

  return (
    <div className="rounded-lg border border-border/50 bg-muted/20" style={{ fontSize: '11px' }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left hover:bg-muted/30"
      >
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <span style={{ fontSize: '10px' }}>{open ? '▾' : '▸'}</span>
          <span className="font-medium">
            {calls.length} tool call{calls.length === 1 ? '' : 's'}
          </span>
          {failed > 0 ? (
            <span className="rounded-full bg-destructive/20 px-1.5 text-destructive">{failed} failed</span>
          ) : null}
        </span>
        <span className="truncate text-muted-foreground" style={{ maxWidth: '160px' }}>
          {calls.map((c) => VERB[c.toolName] ?? c.toolName).join(' · ')}
        </span>
      </button>
      {open ? (
        <div className="border-t border-border/40">
          {calls.map((c, i) => {
            const isExp = expanded === i;
            return (
              <div key={i} className="border-b border-border/30 last:border-0">
                <button
                  type="button"
                  onClick={() => setExpanded(isExp ? null : i)}
                  className="flex w-full items-center justify-between gap-2 px-2.5 py-1 text-left hover:bg-muted/30"
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span
                      className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${
                        c.ok ? 'bg-emerald-500' : 'bg-destructive'
                      }`}
                    />
                    <span className="truncate font-mono">{label(c)}</span>
                  </span>
                  <span className="shrink-0 text-muted-foreground">
                    {c.durationMs !== undefined ? `${c.durationMs}ms` : ''}
                  </span>
                </button>
                {isExp ? (
                  <div className="space-y-1 px-2.5 pb-2 font-mono" style={{ fontSize: '10px' }}>
                    {c.args && Object.keys(c.args).length > 0 ? (
                      <div className="rounded bg-muted/40 p-1.5">
                        <div className="mb-0.5 text-muted-foreground">args</div>
                        <pre className="whitespace-pre-wrap" style={{ overflowWrap: 'anywhere' }}>
                          {JSON.stringify(c.args, null, 2)}
                        </pre>
                      </div>
                    ) : null}
                    {c.error ? (
                      <div className="rounded bg-destructive/10 p-1.5 text-destructive">
                        <div className="mb-0.5">error</div>
                        <pre className="whitespace-pre-wrap" style={{ overflowWrap: 'anywhere' }}>
                          {c.error}
                        </pre>
                      </div>
                    ) : c.resultPreview ? (
                      <div className="rounded bg-muted/40 p-1.5">
                        <div className="mb-0.5 text-muted-foreground">result</div>
                        <pre className="whitespace-pre-wrap" style={{ overflowWrap: 'anywhere' }}>
                          {c.resultPreview}
                        </pre>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
