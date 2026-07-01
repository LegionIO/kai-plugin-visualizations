import React, { useMemo, useRef, useState, useEffect } from 'react';
import type { ActiveProject, NavEntry, ProjectMeta, Engine, Revision, VizDefaults } from '../../shared/types.js';
import { DiagramCanvas, type CanvasHandle } from './DiagramCanvas';
import { SourceEditor } from './SourceEditor';
import { RevisionHistory } from './RevisionHistory';
import { ExportMenu } from './ExportMenu';
import { Breadcrumbs } from './Breadcrumbs';

type Tab = 'preview' | 'source' | 'history';

type Props = {
  active: ActiveProject;
  projects: ProjectMeta[];
  navStack: NavEntry[];
  defaults?: VizDefaults;
  focusNode: string | null;
  pending: boolean;
  onNavigate: (projectId: string, nodeId?: string) => void;
  onNavBack: (toIndex: number) => void;
  onRename: (name: string) => void;
  onSaveFragment: (fragmentId: string, engine: Engine, source: string) => void;
  onCreateFragment: (name: string) => void;
  onDeleteFragment: (fragmentId: string) => void;
  onRenameFragment: (fragmentId: string, name: string) => void;
  onReorderFragments: (order: string[]) => void;
  onCheckout: (revisionId: string) => void;
  onUndo: () => void;
  onRedo: (revisionId?: string) => void;
  onDuplicate: () => void;
};

export function Workspace({
  active,
  projects,
  navStack,
  defaults,
  focusNode,
  pending,
  onNavigate,
  onNavBack,
  onRename,
  onSaveFragment,
  onCreateFragment,
  onDeleteFragment,
  onRenameFragment,
  onReorderFragments,
  onCheckout,
  onUndo,
  onRedo,
  onDuplicate,
}: Props) {
  const [tab, setTab] = useState<Tab>('preview');
  const [nameDraft, setNameDraft] = useState(active.meta.name);
  const canvasRef = useRef<CanvasHandle | null>(null);

  useEffect(() => {
    setNameDraft(active.meta.name);
    setTab('preview');
  }, [active.meta.id]);

  useEffect(() => {
    setNameDraft(active.meta.name);
  }, [active.meta.name]);

  const linkedProjects = active.meta.links
    .map((id) => projects.find((p) => p.id === id))
    .filter((p): p is ProjectMeta => Boolean(p));

  const { canUndo, redoTargets } = useMemo(() => {
    const byId = new Map(active.revisions.map((r) => [r.id, r]));
    const head = active.meta.headRevisionId;
    const headRev = head ? byId.get(head) : undefined;
    const children: Revision[] = active.revisions
      .filter((r) => r.parentId === head && head !== undefined)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return { canUndo: Boolean(headRev?.parentId), redoTargets: children };
  }, [active.revisions, active.meta.headRevisionId]);

  const tabs: Array<{ id: Tab; label: string; badge?: number }> = [
    { id: 'preview', label: 'Preview' },
    { id: 'source', label: 'Source' },
    { id: 'history', label: 'History', badge: active.revisions.length },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Breadcrumbs
        navStack={navStack}
        projects={projects}
        currentName={active.meta.name}
        onBack={onNavBack}
      />

      {/* Header */}
      <div className="flex items-center justify-between gap-3 border-b border-border/50 px-4 py-2">
        <input
          value={nameDraft}
          onChange={(e) => setNameDraft(e.target.value)}
          onBlur={() => {
            if (nameDraft.trim() && nameDraft !== active.meta.name) onRename(nameDraft.trim());
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          }}
          className="min-w-0 flex-1 bg-transparent text-sm font-medium outline-none focus:bg-muted/30 focus:px-2 focus:py-1 focus:rounded"
        />
        <span className="rounded-full bg-muted/60 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {active.meta.engine}
        </span>
        <div className="flex items-center gap-0.5 rounded-lg border border-border/70 bg-card/80">
          <button
            type="button"
            title="Undo (checkout parent revision)"
            disabled={!canUndo || pending}
            onClick={onUndo}
            className="rounded-l-lg px-2 py-1 text-xs hover:bg-muted/50 disabled:opacity-30"
          >
            ↶
          </button>
          <button
            type="button"
            title={
              redoTargets.length > 1
                ? `Redo (${redoTargets.length} branches — newest; use History to pick another)`
                : 'Redo (checkout child revision)'
            }
            disabled={redoTargets.length === 0 || pending}
            onClick={() => onRedo(redoTargets[0]?.id)}
            className="rounded-r-lg px-2 py-1 text-xs hover:bg-muted/50 disabled:opacity-30"
          >
            ↷{redoTargets.length > 1 ? <sup style={{ fontSize: '9px' }}>{redoTargets.length}</sup> : null}
          </button>
        </div>
        <button
          type="button"
          title="Duplicate this project"
          onClick={onDuplicate}
          className="rounded-lg border border-border/70 bg-card/80 px-2 py-1 text-xs hover:bg-muted/50"
        >
          ⧉
        </button>
        <ExportMenu
          name={active.meta.name}
          engine={active.meta.engine}
          source={active.meta.source}
          canvasRef={canvasRef}
          previewMounted={tab === 'preview' && active.meta.source.trim().length > 0}
        />
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 border-b border-border/50 px-3">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`border-b-2 px-3 py-2 text-xs font-medium ${
              tab === t.id
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {t.label}
            {t.badge ? (
              <span className="ml-1.5 rounded-full bg-muted/60 px-1.5 py-0.5 text-[10px]">
                {t.badge}
              </span>
            ) : null}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="min-h-0 flex-1">
        {tab === 'preview' ? (
          <DiagramCanvas
            projectId={active.meta.id}
            engine={active.meta.engine}
            source={active.meta.source}
            defaults={defaults}
            focusNode={focusNode}
            onNavigate={onNavigate}
            handleRef={canvasRef}
          />
        ) : tab === 'source' ? (
          <SourceEditor
            engine={active.meta.engine}
            fragments={active.fragments}
            disabled={pending}
            onSaveFragment={(fid, eng, src) => {
              if (pending) return;
              onSaveFragment(fid, eng, src);
            }}
            onCreateFragment={onCreateFragment}
            onDeleteFragment={onDeleteFragment}
            onRenameFragment={onRenameFragment}
            onReorder={onReorderFragments}
          />
        ) : (
          <RevisionHistory
            revisions={active.revisions}
            headId={active.meta.headRevisionId}
            onCheckout={(revId) => {
              if (pending) return;
              onCheckout(revId);
              setTab('preview');
            }}
          />
        )}
      </div>

      {/* Linked chips */}
      {linkedProjects.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5 border-t border-border/50 bg-muted/10 px-4 py-2">
          <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            Links to
          </span>
          {linkedProjects.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => onNavigate(p.id)}
              className="rounded-full border border-border/60 bg-card/80 px-2.5 py-0.5 text-[11px] hover:bg-muted/50"
            >
              {p.name}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
