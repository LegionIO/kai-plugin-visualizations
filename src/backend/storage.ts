import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, renameSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';
import type {
  PluginAPI,
  ProjectMeta,
  ProjectData,
  Message,
  Revision,
  Engine,
  Fragment,
  VizDefaults,
  NavEntry,
  RevisionAuthor,
} from '../shared/types.js';
import { composeFragments, decomposeFragments, newFragment } from './fragments.js';
import { ENGINES, VIZ_LINK_SCHEME } from '../shared/constants.js';

const ID_RE = /^[A-Za-z0-9_-]+$/;

export function isEngine(v: unknown): v is Engine {
  return typeof v === 'string' && (ENGINES as readonly string[]).includes(v);
}

/** Best-effort engine detection when a caller supplies source but no engine. */
export function inferEngine(source: string, fallback: Engine): Engine {
  const trimmed = source.trim();
  if (!trimmed) return fallback;
  if (trimmed.startsWith('{')) {
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj === 'object' && 'type' in obj && 'data' in obj) return 'chartjs';
    } catch {
      /* not JSON */
    }
  }
  return 'mermaid';
}

/** Extract distinct project ids referenced via viz://<id>[#node] anywhere in source. */
export function extractLinks(source: string): string[] {
  const ids = new Set<string>();
  const re = /viz:\/\/([A-Za-z0-9_-]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    ids.add(m[1]);
  }
  return [...ids];
}

export class VizStorage {
  private api: PluginAPI;
  private dataDir: string;

  constructor(api: PluginAPI) {
    this.api = api;
    // pluginDir (<appHome>/plugins/<name>) is wiped on marketplace update;
    // store user data alongside it under <appHome>/data/<name>. Deriving from
    // pluginDir respects KAI_USER_DATA / branded app-home overrides.
    const appHome = api.pluginDir ? dirname(dirname(api.pluginDir)) : join(homedir(), '.kai');
    this.dataDir = join(appHome, 'data', api.pluginName);
  }

  private emit(event: string, payload: Record<string, unknown>): void {
    try {
      this.api.events?.emit(event, payload);
    } catch (err) {
      this.api.log.warn(`events.emit(${event}) failed:`, err);
    }
  }

  /* ── Project meta (config) ── */

  getProjects(): Record<string, ProjectMeta> {
    const data = this.api.config.getPluginData();
    return (data.projects as Record<string, ProjectMeta>) ?? {};
  }

  listProjects(): ProjectMeta[] {
    return Object.values(this.getProjects()).sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
  }

  getProject(id: string): ProjectMeta | null {
    if (!ID_RE.test(id)) return null;
    const projects = this.getProjects();
    return Object.hasOwn(projects, id) ? projects[id] : null;
  }

  createProject(opts: { name?: string; engine?: Engine; source?: string }): ProjectMeta {
    const now = new Date().toISOString();
    // Current source is duplicated in config (vs. head revision on disk) so
    // list/search and AI-tool reads don't need per-project file I/O.
    const source = opts.source ?? '';
    const meta: ProjectMeta = {
      id: randomUUID().replace(/-/g, '').slice(0, 12),
      name: opts.name?.trim() || 'Untitled',
      engine: opts.engine ?? this.getDefaults().engine ?? 'mermaid',
      source,
      links: extractLinks(source),
      createdAt: now,
      updatedAt: now,
    };
    const projects = this.getProjects();
    projects[meta.id] = meta;
    this.api.config.setPluginData('projects', projects);
    this.writeProjectData(meta.id, {
      messages: [],
      revisions: [],
      fragments: [newFragment('main', source)],
    });
    this.emit('visualization.created', { id: meta.id, name: meta.name, engine: meta.engine });
    return meta;
  }

  updateProject(
    id: string,
    patch: Partial<Pick<ProjectMeta, 'name' | 'engine' | 'source' | 'headRevisionId'>>,
  ): ProjectMeta | null {
    const existing = this.getProject(id);
    if (!existing) return null;
    const projects = this.getProjects();
    const next: ProjectMeta = {
      ...existing,
      ...patch,
      links: patch.source !== undefined ? extractLinks(patch.source) : existing.links,
      updatedAt: new Date().toISOString(),
    };
    projects[id] = next;
    this.api.config.setPluginData('projects', projects);
    if (patch.name !== undefined && patch.name !== existing.name) {
      this.emit('visualization.renamed', { id, name: next.name, previousName: existing.name });
    }
    return next;
  }

  deleteProject(id: string): void {
    const existing = this.getProject(id);
    if (!existing) return;
    const projects = this.getProjects();
    delete projects[id];
    this.api.config.setPluginData('projects', projects);
    const file = this.dataPath(id);
    if (existsSync(file)) {
      try {
        rmSync(file);
      } catch (e) {
        this.api.log.warn('Failed to delete project data file', id, e);
      }
    }
    if (this.getActiveProjectId() === id) {
      this.setActiveProjectId(null);
    }
    const stack = this.getNavStack().filter((e) => e.id !== id);
    this.setNavStack(stack);
    this.emit('visualization.deleted', { id, name: existing.name, engine: existing.engine });
  }

  /* ── Project data (filesystem) ── */

  private dataPath(id: string): string {
    if (!ID_RE.test(id)) throw new Error(`Invalid project id: "${id}"`);
    return join(this.dataDir, `${id}.json`);
  }

  readProjectData(id: string): ProjectData {
    const file = this.dataPath(id);
    if (!existsSync(file)) {
      return { messages: [], revisions: [], fragments: [newFragment('main', this.getProject(id)?.source ?? '')] };
    }
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf-8')) as Partial<ProjectData>;
      const meta = this.getProject(id);
      let fragments = Array.isArray(parsed.fragments) ? parsed.fragments : [];
      if (fragments.length === 0) {
        fragments = [newFragment('main', meta?.source ?? '')];
      }
      return {
        messages: Array.isArray(parsed.messages) ? parsed.messages : [],
        revisions: Array.isArray(parsed.revisions) ? parsed.revisions : [],
        fragments,
      };
    } catch (e) {
      const backup = `${file}.corrupt-${Date.now()}`;
      try {
        renameSync(file, backup);
        this.api.log.error(`Corrupt project data for ${id}; moved to ${backup}`, e);
      } catch {
        this.api.log.error(`Corrupt project data for ${id} (backup failed)`, e);
      }
      return { messages: [], revisions: [], fragments: [newFragment('main')] };
    }
  }

  private writeProjectData(id: string, data: ProjectData): void {
    if (!existsSync(this.dataDir)) mkdirSync(this.dataDir, { recursive: true });
    const target = this.dataPath(id);
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
    renameSync(tmp, target);
  }

  appendMessage(id: string, msg: Omit<Message, 'id' | 'createdAt'> & { id?: string }): Message {
    const data = this.readProjectData(id);
    const full: Message = {
      id: msg.id ?? randomUUID(),
      createdAt: new Date().toISOString(),
      ...msg,
    };
    data.messages.push(full);
    this.writeProjectData(id, data);
    return full;
  }

  replaceMessages(id: string, messages: Message[]): void {
    const data = this.readProjectData(id);
    data.messages = messages;
    this.writeProjectData(id, data);
  }

  updateMessage(id: string, messageId: string, patch: Partial<Message>): void {
    const data = this.readProjectData(id);
    const idx = data.messages.findIndex((m) => m.id === messageId);
    if (idx === -1) return;
    data.messages[idx] = { ...data.messages[idx], ...patch };
    this.writeProjectData(id, data);
  }

  addRevision(
    id: string,
    rev: {
      engine: Engine;
      source: string;
      author: RevisionAuthor;
      messageId?: string;
      fragments?: Fragment[];
    },
  ): Revision {
    const meta = this.getProject(id);
    if (!meta) throw new Error(`addRevision: project "${id}" does not exist`);
    const data = this.readProjectData(id);
    const full: Revision = {
      id: randomUUID(),
      parentId: meta.headRevisionId,
      createdAt: new Date().toISOString(),
      engine: rev.engine,
      source: rev.source,
      author: rev.author,
      messageId: rev.messageId,
    };
    data.revisions.push(full);
    data.fragments = rev.fragments
      ? rev.fragments.map((f) => ({ ...f }))
      : decomposeFragments(rev.source, data.fragments);
    this.writeProjectData(id, data);
    this.updateProject(id, { engine: rev.engine, source: rev.source, headRevisionId: full.id });
    this.emit('visualization.updated', {
      id,
      name: meta.name,
      engine: rev.engine,
      revisionId: full.id,
      author: rev.author,
    });
    return full;
  }

  setFragments(id: string, fragments: Fragment[]): void {
    const data = this.readProjectData(id);
    data.fragments = fragments.map((f) => ({ ...f }));
    this.writeProjectData(id, data);
    this.updateProject(id, { source: composeFragments(data.fragments) });
  }

  getRevision(id: string, revisionId: string): Revision | null {
    const data = this.readProjectData(id);
    return data.revisions.find((r) => r.id === revisionId) ?? null;
  }

  /** Move head to an existing revision without creating a new one. */
  checkoutRevision(id: string, revisionId: string): ProjectMeta | null {
    const rev = this.getRevision(id, revisionId);
    if (!rev) return null;
    const data = this.readProjectData(id);
    data.fragments = decomposeFragments(rev.source, data.fragments);
    this.writeProjectData(id, data);
    return this.updateProject(id, {
      engine: rev.engine,
      source: rev.source,
      headRevisionId: rev.id,
    });
  }

  /** Clone a project (meta + full history). Returns the new project. */
  duplicateProject(id: string): ProjectMeta | null {
    const src = this.getProject(id);
    if (!src) return null;
    const now = new Date().toISOString();
    const copy: ProjectMeta = {
      ...src,
      id: randomUUID().replace(/-/g, '').slice(0, 12),
      name: `${src.name} (copy)`,
      createdAt: now,
      updatedAt: now,
    };
    const projects = this.getProjects();
    projects[copy.id] = copy;
    this.api.config.setPluginData('projects', projects);
    this.writeProjectData(copy.id, this.readProjectData(id));
    this.emit('visualization.created', {
      id: copy.id,
      name: copy.name,
      engine: copy.engine,
      duplicatedFrom: src.id,
    });
    return copy;
  }

  /** Parent of the current head, or null if at root. */
  headParent(id: string): string | null {
    const meta = this.getProject(id);
    if (!meta?.headRevisionId) return null;
    return this.getRevision(id, meta.headRevisionId)?.parentId ?? null;
  }

  /** Children of the current head, newest first. */
  headChildren(id: string): Revision[] {
    const meta = this.getProject(id);
    if (!meta?.headRevisionId) return [];
    return this.readProjectData(id)
      .revisions.filter((r) => r.parentId === meta.headRevisionId)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  /* ── Nav / active ── */

  getActiveProjectId(): string | null {
    const data = this.api.config.getPluginData();
    return (data.activeProjectId as string) ?? null;
  }

  setActiveProjectId(id: string | null): void {
    this.api.config.setPluginData('activeProjectId', id);
  }

  getNavStack(): NavEntry[] {
    const data = this.api.config.getPluginData();
    return (data.navStack as NavEntry[]) ?? [];
  }

  setNavStack(stack: NavEntry[]): void {
    this.api.config.setPluginData('navStack', stack);
  }

  /* ── Defaults ── */

  getDefaults(): VizDefaults {
    const data = this.api.config.getPluginData();
    return (data.defaults as VizDefaults) ?? {};
  }

  setDefaults(defaults: VizDefaults): void {
    this.api.config.setPluginData('defaults', defaults);
  }

  /* ── Search ── */

  search(query: string): ProjectMeta[] {
    const q = query.trim().toLowerCase();
    if (!q) return this.listProjects();
    return this.listProjects().filter(
      (p) => p.name.toLowerCase().includes(q) || p.source.toLowerCase().includes(q),
    );
  }
}

export { VIZ_LINK_SCHEME };
