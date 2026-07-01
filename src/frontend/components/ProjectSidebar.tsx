import React, { useState } from 'react';
import type { ProjectMeta } from '../../shared/types.js';

type Props = {
  projects: ProjectMeta[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onDelete: (id: string) => void;
  onDuplicate: (id: string) => void;
};

function relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.round(diff / 60000);
  if (min < 1) return 'now';
  if (min < 60) return `${min}m`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h`;
  return `${Math.round(hr / 24)}d`;
}

export function ProjectSidebar({ projects, activeId, onSelect, onCreate, onDelete, onDuplicate }: Props) {
  const [confirmId, setConfirmId] = useState<string | null>(null);

  return (
    <div
      className="flex h-full min-h-0 flex-col border-r border-border/50 bg-card/30"
      style={{ width: '224px', flexShrink: 0 }}
    >
      <div className="flex items-center justify-between border-b border-border/50 px-3 py-2.5">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Projects
        </span>
        <button
          type="button"
          onClick={onCreate}
          title="New project"
          className="rounded-lg border border-border/70 bg-card/80 px-2 py-1 text-xs font-medium hover:bg-muted/50"
        >
          + New
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {projects.length === 0 ? (
          <div className="p-4 text-center text-[11px] text-muted-foreground">
            No projects yet.
          </div>
        ) : (
          projects.map((p) => {
            const isActive = p.id === activeId;
            const isConfirm = confirmId === p.id;
            return (
              <div
                key={p.id}
                onClick={() => onSelect(p.id)}
                className={`group flex cursor-pointer items-start justify-between gap-2 border-b border-border/30 px-3 py-2.5 ${
                  isActive ? 'bg-primary/10' : 'hover:bg-muted/30'
                }`}
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{p.name}</div>
                  <div className="mt-0.5 flex items-center gap-2 text-[10px] text-muted-foreground">
                    <span>{p.engine}</span>
                    <span>·</span>
                    <span>{relTime(p.updatedAt)}</span>
                    {p.links.length > 0 ? (
                      <span title={`Links to ${p.links.length} project(s)`}>
                        · 🔗{p.links.length}
                      </span>
                    ) : null}
                  </div>
                </div>
                <div className="flex items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
                  <button
                    type="button"
                    title="Duplicate"
                    onClick={() => onDuplicate(p.id)}
                    className="rounded px-1.5 py-0.5 text-[10px] text-muted-foreground opacity-0 hover:bg-muted/60 group-hover:opacity-100"
                  >
                    ⧉
                  </button>
                  <button
                    type="button"
                    title="Delete"
                    onClick={() => {
                      if (isConfirm) {
                        onDelete(p.id);
                        setConfirmId(null);
                      } else {
                        setConfirmId(p.id);
                        setTimeout(() => setConfirmId((c) => (c === p.id ? null : c)), 3000);
                      }
                    }}
                    className={`rounded px-1.5 py-0.5 text-[10px] ${
                      isConfirm
                        ? 'bg-destructive text-destructive-foreground'
                        : 'text-muted-foreground opacity-0 hover:bg-muted/60 group-hover:opacity-100'
                    }`}
                  >
                    {isConfirm ? 'Delete?' : '✕'}
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
