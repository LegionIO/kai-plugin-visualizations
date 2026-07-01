import type { ENGINES } from './constants.js';

export type Engine = (typeof ENGINES)[number];

export type ProjectMeta = {
  id: string;
  name: string;
  engine: Engine;
  source: string;
  /** Outbound project ids referenced via viz:// in source. Derived on save. */
  links: string[];
  /** Currently checked-out revision. Undefined only when the project has no revisions yet. */
  headRevisionId?: string;
  createdAt: string;
  updatedAt: string;
};

export type RevisionAuthor = 'ai' | 'user' | 'tool';

export type Revision = {
  id: string;
  /** The revision this one was derived from. Absent for the root. */
  parentId?: string;
  engine: Engine;
  source: string;
  author: RevisionAuthor;
  /** Chat message id that produced this revision, if any. */
  messageId?: string;
  createdAt: string;
};

export type ToolCallSummary = {
  toolName: string;
  args?: Record<string, unknown>;
  ok: boolean;
  error?: string;
  durationMs?: number;
  resultPreview?: string;
};

export type Message = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** Revision id created by this assistant message, if it changed the diagram. */
  revisionId?: string;
  /** Line-diff summary against the previous source, when a revision was applied. */
  diff?: { added: number; removed: number };
  /** Trace of viz_frag_* tool calls the agent made this turn. */
  toolCalls?: ToolCallSummary[];
  /** Non-blocking warning shown alongside the message (e.g. no-op source). */
  warning?: string;
  error?: string;
  createdAt: string;
};

export type Fragment = {
  id: string;
  name: string;
  source: string;
};

export type ProjectData = {
  messages: Message[];
  revisions: Revision[];
  fragments: Fragment[];
};

export type MermaidLook = 'classic' | 'handDrawn' | 'neo';
export type MermaidCurve = 'basis' | 'linear' | 'natural' | 'step';

export type VizDefaults = {
  engine?: Engine;
  modelOverride?: string;
  maxHistoryMessages?: number;
  mermaidLook?: MermaidLook;
  mermaidCurve?: MermaidCurve;
};

export type ActiveProject = {
  meta: ProjectMeta;
  messages: Message[];
  revisions: Revision[];
  fragments: Fragment[];
};

/** Breadcrumb entry: where we came from and (optionally) which node was focused there. */
export type NavEntry = {
  id: string;
  focusNode?: string;
};

export type VizState = {
  projects: ProjectMeta[];
  activeProjectId: string | null;
  /** Node to highlight in the active diagram (from viz://...#node deep link). */
  focusNode: string | null;
  navStack: NavEntry[];
  active: ActiveProject | null;
  /** Project ids with an in-flight AI generation. */
  pending: string[];
  defaults: VizDefaults;
  error: string | null;
};

/** Parsed viz:// link target. */
export type VizLink = {
  projectId: string;
  nodeId?: string;
};

/* ── Minimal PluginAPI surface used by this plugin ── */

export type PluginAgentMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

export type PluginAgentGenerateOptions = {
  messages: PluginAgentMessage[];
  modelKey?: string;
  profileKey?: string;
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh';
  fallbackEnabled?: boolean;
  systemPrompt?: string;
  maxTokens?: number;
  tools?: boolean;
  abortSignal?: AbortSignal;
};

export type PluginAgentGenerateResult = {
  text: string;
  modelKey: string;
  toolCalls: Array<{
    toolName: string;
    args: unknown;
    result: unknown;
    error?: string;
    durationMs?: number;
  }>;
};

export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: unknown;
  execute: (input: unknown, context?: unknown) => Promise<unknown>;
};

export type PluginAPI = {
  pluginName: string;
  pluginDir: string;
  config: {
    get: () => Record<string, unknown>;
    set: (path: string, value: unknown) => void;
    getPluginData: () => Record<string, unknown>;
    setPluginData: (path: string, value: unknown) => void;
    onChanged: (cb: (config: Record<string, unknown>) => void) => () => void;
  };
  state: {
    get: () => Record<string, unknown>;
    replace: (next: Record<string, unknown>) => void;
    set: (path: string, value: unknown) => void;
    emitEvent: (eventName: string, data?: unknown) => void;
  };
  tools: {
    register: (tools: ToolDefinition[]) => void;
    unregister: (toolNames: string[]) => void;
  };
  ui: {
    registerPanelView: (descriptor: Record<string, unknown>) => void;
    registerNavigationItem: (descriptor: Record<string, unknown>) => void;
    registerSettingsView: (descriptor: Record<string, unknown>) => void;
  };
  notifications: {
    show: (descriptor: Record<string, unknown>) => void;
    dismiss: (id: string) => void;
  };
  agent: {
    generate: (options: PluginAgentGenerateOptions) => Promise<PluginAgentGenerateResult>;
  };
  log: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
  onAction: (targetId: string, handler: (action: string, data?: unknown) => void | Promise<void>) => void;
  fetch: typeof globalThis.fetch;
};
