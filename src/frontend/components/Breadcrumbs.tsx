import React from 'react';
import type { NavEntry, ProjectMeta } from '../../shared/types.js';

type Props = {
  navStack: NavEntry[];
  projects: ProjectMeta[];
  currentName: string;
  onBack: (toIndex: number) => void;
};

export function Breadcrumbs({ navStack, projects, currentName, onBack }: Props) {
  if (navStack.length === 0) return null;
  const nameOf = (id: string) => projects.find((p) => p.id === id)?.name ?? id;

  return (
    <div className="flex flex-wrap items-center gap-1 border-b border-border/40 bg-muted/20 px-4 py-1.5 text-[11px]">
      {navStack.map((entry, i) => (
        <React.Fragment key={`${entry.id}-${i}`}>
          <button
            type="button"
            onClick={() => onBack(i)}
            className="truncate rounded px-1.5 py-0.5 text-muted-foreground hover:bg-muted/60 hover:text-foreground"
            style={{ maxWidth: '160px' }}
            title={nameOf(entry.id)}
          >
            {nameOf(entry.id)}
          </button>
          <span className="text-muted-foreground/60">›</span>
        </React.Fragment>
      ))}
      <span className="truncate px-1.5 py-0.5 font-medium" style={{ maxWidth: '200px' }}>
        {currentName}
      </span>
    </div>
  );
}
