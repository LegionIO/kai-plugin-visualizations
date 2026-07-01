import React, { useCallback } from 'react';
import { usePanelHeight, type PluginComponentProps } from '../hooks';
import type { VizState, Engine } from '../../shared/types.js';
import { ProjectSidebar } from './ProjectSidebar';
import { Workspace } from './Workspace';
import { ChatThread } from './ChatThread';
import { EmptyState } from './EmptyState';

export function PanelView({ onAction, pluginState }: PluginComponentProps<VizState>) {
  const state = (pluginState ?? {}) as Partial<VizState>;
  const projects = state.projects ?? [];
  const active = state.active ?? null;
  const navStack = state.navStack ?? [];
  const focusNode = state.focusNode ?? null;
  const pendingIds = state.pending ?? [];
  const isPending = active ? pendingIds.includes(active.meta.id) : false;
  const [panelRef, panelHeight] = usePanelHeight(520);

  const handleCreate = useCallback(() => onAction('create-project', {}), [onAction]);
  const handleSelect = useCallback((id: string) => onAction('select-project', { id }), [onAction]);
  const handleDelete = useCallback((id: string) => onAction('delete-project', { id }), [onAction]);

  const handleNavigate = useCallback(
    (id: string, nodeId?: string) => {
      if (!active) return;
      onAction('navigate-to', { id, fromId: active.meta.id, focusNode: nodeId });
    },
    [onAction, active],
  );

  const handleNavBack = useCallback(
    (toIndex: number) => onAction('nav-back', { toIndex }),
    [onAction],
  );

  const handleSend = useCallback(
    (text: string) => {
      if (!active) return;
      onAction('send-message', { id: active.meta.id, text });
    },
    [onAction, active],
  );

  const handleAbort = useCallback(() => {
    if (!active) return;
    onAction('abort', { id: active.meta.id });
  }, [onAction, active]);

  const handleRename = useCallback(
    (name: string) => {
      if (!active) return;
      onAction('rename-project', { id: active.meta.id, name });
    },
    [onAction, active],
  );

  const handleSaveFragment = useCallback(
    (fragmentId: string, engine: Engine, source: string) => {
      if (!active) return;
      onAction('update-fragment', { id: active.meta.id, fragmentId, engine, source });
    },
    [onAction, active],
  );

  const handleCreateFragment = useCallback(
    (name: string) => active && onAction('create-fragment', { id: active.meta.id, name }),
    [onAction, active],
  );
  const handleDeleteFragment = useCallback(
    (fragmentId: string) => active && onAction('delete-fragment', { id: active.meta.id, fragmentId }),
    [onAction, active],
  );
  const handleRenameFragment = useCallback(
    (fragmentId: string, name: string) =>
      active && onAction('rename-fragment', { id: active.meta.id, fragmentId, name }),
    [onAction, active],
  );
  const handleReorderFragments = useCallback(
    (order: string[]) => active && onAction('reorder-fragments', { id: active.meta.id, order }),
    [onAction, active],
  );

  const handleCheckout = useCallback(
    (revisionId: string) => {
      if (!active) return;
      onAction('checkout-revision', { id: active.meta.id, revisionId });
    },
    [onAction, active],
  );

  const handleUndo = useCallback(() => {
    if (!active) return;
    onAction('undo', { id: active.meta.id });
  }, [onAction, active]);

  const handleRedo = useCallback(
    (revisionId?: string) => {
      if (!active) return;
      onAction('redo', { id: active.meta.id, revisionId });
    },
    [onAction, active],
  );

  const handleDuplicate = useCallback(() => {
    if (!active) return;
    onAction('duplicate-project', { id: active.meta.id });
  }, [onAction, active]);

  const handleRetry = useCallback(
    (messageId: string) => {
      if (!active) return;
      onAction('retry-message', { id: active.meta.id, messageId });
    },
    [onAction, active],
  );

  return (
    <div
      ref={panelRef}
      className="flex min-h-0 overflow-hidden"
      style={{ height: panelHeight ? `${panelHeight}px` : 'calc(100vh - 8rem)', minHeight: '520px' }}
    >
      <ProjectSidebar
        projects={projects}
        activeId={active?.meta.id ?? null}
        onSelect={handleSelect}
        onCreate={handleCreate}
        onDelete={handleDelete}
        onDuplicate={(id) => onAction('duplicate-project', { id })}
      />

      {active ? (
        <>
          <div className="flex-1 border-r border-border/50" style={{ minWidth: 0 }}>
            <Workspace
              active={active}
              projects={projects}
              navStack={navStack}
              defaults={state.defaults}
              focusNode={focusNode}
              pending={isPending}
              onNavigate={handleNavigate}
              onNavBack={handleNavBack}
              onRename={handleRename}
              onSaveFragment={handleSaveFragment}
              onCreateFragment={handleCreateFragment}
              onDeleteFragment={handleDeleteFragment}
              onRenameFragment={handleRenameFragment}
              onReorderFragments={handleReorderFragments}
              onCheckout={handleCheckout}
              onUndo={handleUndo}
              onRedo={handleRedo}
              onDuplicate={handleDuplicate}
            />
          </div>
          <div className="shrink-0" style={{ width: '380px', maxWidth: '40%' }}>
            <ChatThread
              messages={active.messages}
              pending={isPending}
              isEmpty={active.meta.source.trim().length === 0}
              onSend={handleSend}
              onAbort={handleAbort}
              onRetry={handleRetry}
            />
          </div>
        </>
      ) : (
        <div className="flex-1">
          <EmptyState onCreate={handleCreate} />
        </div>
      )}
    </div>
  );
}
