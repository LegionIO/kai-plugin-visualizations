import type { PluginAPI, VizState, Engine, NavEntry, VizDefaults, ToolCallSummary } from '../shared/types.js';
import { PANEL_ID, NAV_ID, SETTINGS_ID } from '../shared/constants.js';
import { VizStorage, isEngine } from './storage.js';
import { buildVizTools, TOOL_NAMES } from './tools.js';
import {
  buildFragTools,
  openFragSession,
  closeFragSession,
  composeSession,
  finalizeSession,
  FRAG_TOOL_NAMES,
} from './frag-tools.js';
import { runAgent, lineDiff } from './agent.js';
import { composeFragments, newFragment } from './fragments.js';

let storage: VizStorage | null = null;
let apiRef: PluginAPI | null = null;
let focusNode: string | null = null;

/** In-flight generations keyed by project id. */
const inflight = new Map<string, { controller: AbortController }>();

function publishState(): void {
  if (!apiRef || !storage) return;
  const activeId = storage.getActiveProjectId();
  const meta = activeId ? storage.getProject(activeId) : null;
  const data = meta ? storage.readProjectData(meta.id) : null;

  const state: VizState = {
    projects: storage.listProjects(),
    activeProjectId: activeId,
    focusNode,
    navStack: storage.getNavStack(),
    active:
      meta && data
        ? { meta, messages: data.messages, revisions: data.revisions, fragments: data.fragments }
        : null,
    pending: [...inflight.keys()],
    defaults: storage.getDefaults(),
    error: null,
  };
  apiRef.state.replace(state as unknown as Record<string, unknown>);
}

async function handleSendMessage(projectId: string, text: string): Promise<void> {
  if (!apiRef || !storage) return;
  const project = storage.getProject(projectId);
  if (!project) return;
  if (inflight.has(projectId)) return;

  storage.appendMessage(projectId, { role: 'user', content: text });

  const controller = new AbortController();
  const baselineHead = project.headRevisionId ?? null;
  const baseData = storage.readProjectData(projectId);
  const session = openFragSession(projectId, project.engine, baseData.fragments);
  inflight.set(projectId, { controller });
  publishState();

  try {
    const history = baseData.messages.slice(0, -1);
    let result = await runAgent(
      apiRef,
      project,
      baseData.fragments,
      storage.listProjects(),
      history,
      text,
      storage.getDefaults(),
      controller.signal,
    );

    if (controller.signal.aborted || !storage.getProject(projectId)) return;

    // One-shot auto-lint retry: if the agent left the diagram invalid, feed the
    // parse error back and let it fix within the same session.
    if (session.dirty) {
      const v = await finalizeSession(session);
      if (!v.valid) {
        const fixPrompt = `Your edits left the diagram invalid. Parser error:\n\n${v.error}\n\nFix it now using viz_frag_patch/viz_frag_write, then stop.`;
        const retry = await runAgent(
          apiRef,
          project,
          session.fragments,
          storage.listProjects(),
          [
            ...history,
            { id: 'u', role: 'user', content: text, createdAt: '' },
            { id: 'a', role: 'assistant', content: result.text, createdAt: '' },
          ],
          fixPrompt,
          storage.getDefaults(),
          controller.signal,
        );
        if (controller.signal.aborted || !storage.getProject(projectId)) return;
        result = {
          text: `${result.text}\n\n${retry.text}`.trim(),
          toolCalls: [...result.toolCalls, ...retry.toolCalls],
          modelKey: retry.modelKey,
        };
      }
    }

    const fragToolCalls = result.toolCalls.filter((c) =>
      (FRAG_TOOL_NAMES as readonly string[]).includes(c.toolName),
    );

    const summarize = (c: (typeof result.toolCalls)[number]): ToolCallSummary => {
      const rawArgs = (c.args ?? {}) as Record<string, unknown>;
      const args: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(rawArgs)) {
        if (k === 'projectId') continue;
        args[k] = typeof v === 'string' && v.length > 120 ? v.slice(0, 120) + '…' : v;
      }
      let resultPreview: string | undefined;
      if (c.result !== undefined) {
        try {
          const s = JSON.stringify(c.result);
          resultPreview = s.length > 200 ? s.slice(0, 200) + '…' : s;
        } catch {
          resultPreview = String(c.result);
        }
      }
      return {
        toolName: c.toolName,
        args,
        ok: !c.error,
        error: c.error,
        durationMs: c.durationMs,
        resultPreview,
      };
    };

    const assistantMsg = storage.appendMessage(projectId, {
      role: 'assistant',
      content: result.text,
      toolCalls: fragToolCalls.map(summarize),
    });

    if (session.dirty) {
      const current = storage.getProject(projectId);
      const currentHead = current?.headRevisionId ?? null;
      const validation = await finalizeSession(session);
      if (!validation.valid) {
        storage.updateMessage(projectId, assistantMsg.id, {
          error: `Edits produced invalid ${session.engine}: ${validation.error.split('\n')[0]}`,
        });
      } else if (current && currentHead === baselineHead) {
        const prevSource = current.source;
        const nextSource = composeSession(session);
        if (nextSource.trim() === prevSource.trim() && session.engine === current.engine) {
          storage.updateMessage(projectId, assistantMsg.id, {
            warning: 'Agent tool calls resulted in no net change to the diagram.',
          });
        } else {
          const rev = storage.addRevision(projectId, {
            engine: session.engine,
            source: nextSource,
            fragments: session.fragments,
            author: 'ai',
            messageId: assistantMsg.id,
          });
          storage.updateMessage(projectId, assistantMsg.id, {
            revisionId: rev.id,
            diff: lineDiff(prevSource, nextSource),
          });
        }
      } else {
        storage.updateMessage(projectId, assistantMsg.id, {
          error: 'Diagram changed while generating; edits not applied. Ask again to re-apply.',
        });
      }
    } else if (fragToolCalls.length === 0 && !result.text.trim()) {
      storage.updateMessage(projectId, assistantMsg.id, {
        warning: 'Agent made no edits and returned no reply.',
      });
    }
  } catch (err) {
    if (controller.signal.aborted) return;
    const msg = err instanceof Error ? err.message : String(err);
    apiRef.log.error('viz send-message failed', err);
    storage.appendMessage(projectId, { role: 'assistant', content: '', error: msg });
  } finally {
    closeFragSession(projectId);
    if (inflight.get(projectId)?.controller === controller) {
      inflight.delete(projectId);
    }
    publishState();
  }
}

function assertNotPending(projectId: string): boolean {
  if (inflight.has(projectId)) {
    apiRef?.notifications.show({
      id: `viz-busy-${projectId}`,
      title: 'Generation in progress',
      body: 'Wait for the agent to finish (or press Stop) before editing this diagram.',
      autoDismissMs: 4000,
    });
    return false;
  }
  return true;
}

async function handlePanelAction(action: string, raw?: unknown): Promise<void> {
  if (!apiRef || !storage) return;
  const data = (raw ?? {}) as Record<string, unknown>;
  const idOf = () => (typeof data.id === 'string' ? data.id : '');

  switch (action) {
    case 'create-project': {
      const engine = isEngine(data.engine) ? data.engine : undefined;
      const meta = storage.createProject({
        name: typeof data.name === 'string' ? data.name : undefined,
        engine,
      });
      storage.setActiveProjectId(meta.id);
      storage.setNavStack([]);
      focusNode = null;
      break;
    }
    case 'select-project': {
      storage.setActiveProjectId(idOf());
      storage.setNavStack([]);
      focusNode = typeof data.focusNode === 'string' ? data.focusNode : null;
      break;
    }
    case 'navigate-to': {
      const targetId = idOf();
      const fromId = typeof data.fromId === 'string' ? data.fromId : undefined;
      if (!storage.getProject(targetId)) {
        apiRef.notifications.show({
          id: `viz-missing-${targetId}`,
          title: 'Visualization not found',
          body: `Linked project "${targetId}" does not exist.`,
          autoDismissMs: 5000,
        });
        break;
      }
      if (fromId) {
        const stack = storage.getNavStack();
        stack.push({ id: fromId, focusNode: focusNode ?? undefined });
        storage.setNavStack(stack);
      }
      storage.setActiveProjectId(targetId);
      focusNode = typeof data.focusNode === 'string' ? data.focusNode : null;
      break;
    }
    case 'nav-back': {
      const toIndex = typeof data.toIndex === 'number' ? data.toIndex : -1;
      const stack = storage.getNavStack();
      if (toIndex < 0 || toIndex >= stack.length) break;
      const target: NavEntry = stack[toIndex];
      storage.setNavStack(stack.slice(0, toIndex));
      storage.setActiveProjectId(target.id);
      focusNode = target.focusNode ?? null;
      break;
    }
    case 'clear-focus': {
      focusNode = null;
      break;
    }
    case 'rename-project': {
      const name = typeof data.name === 'string' ? data.name.trim() : '';
      if (name) storage.updateProject(idOf(), { name });
      break;
    }
    case 'delete-project': {
      const id = idOf();
      inflight.get(id)?.controller.abort();
      inflight.delete(id);
      storage.deleteProject(id);
      break;
    }
    case 'duplicate-project': {
      const copy = storage.duplicateProject(idOf());
      if (copy) {
        storage.setActiveProjectId(copy.id);
        storage.setNavStack([]);
        focusNode = null;
      }
      break;
    }
    case 'send-message': {
      const t = typeof data.text === 'string' ? data.text.trim() : '';
      if (t) await handleSendMessage(idOf(), t);
      return;
    }
    case 'retry-message': {
      const id = idOf();
      const errId = typeof data.messageId === 'string' ? data.messageId : '';
      if (!id || inflight.has(id)) break;
      const projData = storage.readProjectData(id);
      const idx = projData.messages.findIndex((m) => m.id === errId);
      if (idx === -1) break;
      // Find the user message that preceded this errored assistant reply.
      let userText: string | undefined;
      for (let i = idx - 1; i >= 0; i--) {
        if (projData.messages[i].role === 'user') {
          userText = projData.messages[i].content;
          break;
        }
      }
      if (!userText) break;
      // Drop the errored assistant message and everything after it, then resend.
      storage.replaceMessages(id, projData.messages.slice(0, idx));
      const resend = userText;
      publishState();
      // Remove the trailing user msg too so handleSendMessage re-appends it cleanly.
      const trimmed = storage.readProjectData(id).messages;
      if (trimmed.length && trimmed[trimmed.length - 1].role === 'user') {
        storage.replaceMessages(id, trimmed.slice(0, -1));
      }
      await handleSendMessage(id, resend);
      return;
    }
    case 'update-source': {
      const id = idOf();
      if (!assertNotPending(id)) break;
      const engine: Engine = isEngine(data.engine)
        ? data.engine
        : (storage.getProject(id)?.engine ?? 'mermaid');
      if (typeof data.source !== 'string') break;
      storage.addRevision(id, { engine, source: data.source, author: 'user' });
      break;
    }
    case 'update-fragment': {
      const id = idOf();
      if (!assertNotPending(id)) break;
      const fragId = typeof data.fragmentId === 'string' ? data.fragmentId : '';
      if (!fragId || typeof data.source !== 'string') break;
      const pd = storage.readProjectData(id);
      const frags = pd.fragments.map((f) =>
        f.id === fragId
          ? { ...f, source: data.source as string, name: typeof data.name === 'string' ? data.name : f.name }
          : f,
      );
      const meta = storage.getProject(id);
      storage.addRevision(id, {
        engine: isEngine(data.engine) ? data.engine : (meta?.engine ?? 'mermaid'),
        source: composeFragments(frags),
        fragments: frags,
        author: 'user',
      });
      break;
    }
    case 'create-fragment': {
      const id = idOf();
      if (!assertNotPending(id)) break;
      const name = typeof data.name === 'string' && data.name.trim() ? data.name.trim() : 'fragment';
      const pd = storage.readProjectData(id);
      const frags = [...pd.fragments, newFragment(name)];
      storage.setFragments(id, frags);
      break;
    }
    case 'delete-fragment': {
      const id = idOf();
      if (!assertNotPending(id)) break;
      const fragId = typeof data.fragmentId === 'string' ? data.fragmentId : '';
      const pd = storage.readProjectData(id);
      if (pd.fragments.length <= 1) break;
      const frags = pd.fragments.filter((f) => f.id !== fragId);
      const meta = storage.getProject(id);
      storage.addRevision(id, {
        engine: meta?.engine ?? 'mermaid',
        source: composeFragments(frags),
        fragments: frags,
        author: 'user',
      });
      break;
    }
    case 'rename-fragment': {
      const id = idOf();
      if (!assertNotPending(id)) break;
      const fragId = typeof data.fragmentId === 'string' ? data.fragmentId : '';
      const name = typeof data.name === 'string' ? data.name.trim() : '';
      if (!fragId || !name) break;
      const pd = storage.readProjectData(id);
      storage.setFragments(
        id,
        pd.fragments.map((f) => (f.id === fragId ? { ...f, name } : f)),
      );
      break;
    }
    case 'reorder-fragments': {
      const id = idOf();
      if (!assertNotPending(id)) break;
      const order = Array.isArray(data.order) ? (data.order as string[]) : [];
      const pd = storage.readProjectData(id);
      const byId = new Map(pd.fragments.map((f) => [f.id, f]));
      const frags = order.map((fid) => byId.get(fid)).filter((f): f is NonNullable<typeof f> => !!f);
      for (const f of pd.fragments) if (!order.includes(f.id)) frags.push(f);
      const meta = storage.getProject(id);
      storage.addRevision(id, {
        engine: meta?.engine ?? 'mermaid',
        source: composeFragments(frags),
        fragments: frags,
        author: 'user',
      });
      break;
    }
    case 'checkout-revision': {
      const id = idOf();
      if (!assertNotPending(id)) break;
      const revId = typeof data.revisionId === 'string' ? data.revisionId : '';
      storage.checkoutRevision(id, revId);
      break;
    }
    case 'undo': {
      const id = idOf();
      if (!assertNotPending(id)) break;
      const parent = storage.headParent(id);
      if (parent) storage.checkoutRevision(id, parent);
      break;
    }
    case 'redo': {
      const id = idOf();
      if (!assertNotPending(id)) break;
      const children = storage.headChildren(id);
      const target = typeof data.revisionId === 'string' ? data.revisionId : children[0]?.id;
      if (target) storage.checkoutRevision(id, target);
      break;
    }
    case 'abort': {
      const id = idOf();
      const entry = id ? inflight.get(id) : undefined;
      if (entry) {
        entry.controller.abort();
        inflight.delete(id);
      } else if (!id) {
        for (const e of inflight.values()) e.controller.abort();
        inflight.clear();
      }
      break;
    }
    default:
      apiRef.log.warn('Unknown viz panel action', action);
      return;
  }
  publishState();
}

function handleSettingsAction(action: string, data?: unknown): void {
  if (!storage) return;
  if (action === 'set-defaults') {
    const d = (data ?? {}) as Partial<VizDefaults>;
    const next: VizDefaults = {
      engine: isEngine(d.engine) ? d.engine : undefined,
      modelOverride: typeof d.modelOverride === 'string' && d.modelOverride.trim() ? d.modelOverride.trim() : undefined,
      maxHistoryMessages:
        typeof d.maxHistoryMessages === 'number' && Number.isFinite(d.maxHistoryMessages)
          ? Math.max(1, Math.round(d.maxHistoryMessages))
          : undefined,
      mermaidLook:
        d.mermaidLook === 'handDrawn' || d.mermaidLook === 'classic' || d.mermaidLook === 'neo'
          ? d.mermaidLook
          : undefined,
      mermaidCurve:
        d.mermaidCurve === 'basis' || d.mermaidCurve === 'linear' || d.mermaidCurve === 'natural' || d.mermaidCurve === 'step'
          ? d.mermaidCurve
          : undefined,
    };
    storage.setDefaults(next);
    publishState();
  }
}

export async function activate(api: PluginAPI): Promise<void> {
  apiRef = api;
  storage = new VizStorage(api);

  api.ui.registerPanelView({ id: PANEL_ID, title: 'Visualizations', visible: true, width: 'full' });
  api.ui.registerNavigationItem({
    id: NAV_ID,
    visible: true,
    target: { type: 'panel', panelId: PANEL_ID },
  });
  api.ui.registerSettingsView({ id: SETTINGS_ID, label: 'Visualizations' });

  try {
    api.events?.declare({
      events: [
        {
          event: 'visualization.created',
          title: 'Visualization created',
          description: 'A new diagram/chart project was created (or duplicated).',
          payloadSchema: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              engine: { type: 'string', enum: ['mermaid', 'chartjs'] },
              duplicatedFrom: { type: 'string', description: 'Source project id when created via duplicate.' },
            },
          },
        },
        {
          event: 'visualization.updated',
          title: 'Visualization updated',
          description:
            'A new revision was committed to a diagram/chart. Does not fire on undo/redo/checkout (head moves to an existing revision) or fragment create/rename (no new revision).',
          payloadSchema: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              engine: { type: 'string', enum: ['mermaid', 'chartjs'] },
              revisionId: { type: 'string' },
              author: { type: 'string', enum: ['ai', 'user', 'tool'] },
            },
          },
        },
        {
          event: 'visualization.renamed',
          title: 'Visualization renamed',
          payloadSchema: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              previousName: { type: 'string' },
            },
          },
        },
        {
          event: 'visualization.deleted',
          title: 'Visualization deleted',
          payloadSchema: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              engine: { type: 'string', enum: ['mermaid', 'chartjs'] },
            },
          },
        },
      ],
    });
  } catch (err) {
    api.log.warn('events.declare unavailable:', err);
  }

  api.onAction(`panel:${PANEL_ID}`, (action, data) => handlePanelAction(action, data));
  // Kai routes settings actions by registered component name, not descriptor id
  // (see kai-desktop PluginSettingsModal: `settings:${pluginSection.component}`).
  api.onAction('settings:SettingsView', (action, data) => handleSettingsAction(action, data));

  api.tools.register([
    ...buildVizTools({
      api,
      storage,
      publish: publishState,
      abortForProject: (id) => {
        inflight.get(id)?.controller.abort();
        inflight.delete(id);
      },
    }),
    ...buildFragTools((projectId) => {
      // No live edit session (e.g. validate/list/read/grep called outside a
      // generation turn): serve a transient, committed-source view from storage.
      const project = storage?.getProject(projectId);
      if (!storage || !project) return undefined;
      const data = storage.readProjectData(projectId);
      return {
        projectId,
        engine: project.engine,
        fragments: data.fragments.map((f) => ({ ...f })),
        dirty: false,
        log: [],
        committed: true,
      };
    }),
  ]);

  publishState();
  api.log.info('visualizations plugin activated');
}

export async function deactivate(): Promise<void> {
  for (const e of inflight.values()) e.controller.abort();
  inflight.clear();
  try {
    apiRef?.tools.unregister([...TOOL_NAMES, ...FRAG_TOOL_NAMES]);
  } catch {
    /* host may auto-unregister */
  }
  storage = null;
  apiRef = null;
  focusNode = null;
}
