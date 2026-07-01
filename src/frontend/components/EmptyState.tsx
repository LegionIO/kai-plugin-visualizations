import React from 'react';

export function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
      <div className="rounded-2xl border border-dashed border-border/60 bg-card/40 p-10">
        <div className="text-lg font-medium">No visualization selected</div>
        <div className="mt-1 max-w-md text-sm text-muted-foreground">
          Create a project and describe what you want — an ERD, an architecture diagram, a
          sequence flow, or a data chart. The agent will generate it and you can iterate from
          there.
        </div>
        <button
          type="button"
          onClick={onCreate}
          className="mt-5 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          + New Project
        </button>
      </div>
    </div>
  );
}
