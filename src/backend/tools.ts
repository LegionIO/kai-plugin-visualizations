import type { PluginAPI, ToolDefinition, Engine, ProjectMeta } from '../shared/types.js';
import { VizStorage, isEngine, inferEngine } from './storage.js';
import { runAgent } from './agent.js';
import { openFragSession, closeFragSession, composeSession } from './frag-tools.js';

type Deps = {
  api: PluginAPI;
  storage: VizStorage;
  publish: () => void;
  abortForProject: (id: string) => void;
};

export const TOOL_NAMES = [
  'viz_list_projects',
  'viz_get_project',
  'viz_create_project',
  'viz_update_project',
  'viz_delete_project',
  'viz_duplicate_project',
] as const;

function summarize(p: ProjectMeta) {
  return {
    id: p.id,
    name: p.name,
    engine: p.engine,
    links: p.links,
    updatedAt: p.updatedAt,
    sourcePreview: p.source.length > 200 ? p.source.slice(0, 200) + '…' : p.source,
  };
}

function requireString(v: unknown, field: string): string {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`"${field}" must be a non-empty string.`);
  return v.trim();
}

function optionalString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function coerceEngine(v: unknown, source: string | undefined, fallback: Engine): Engine {
  if (isEngine(v)) return v;
  if (v !== undefined) throw new Error(`"engine" must be one of: mermaid, chartjs.`);
  return source !== undefined ? inferEngine(source, fallback) : fallback;
}

export function buildVizTools({ api, storage, publish, abortForProject }: Deps): ToolDefinition[] {
  return [
    {
      name: 'viz_list_projects',
      description:
        'List or search visualization projects (diagrams/charts) managed by the Visualizations plugin. Returns id, name, engine, outbound links, and a source preview. Pass `query` to substring-search names and source.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Optional substring to filter by name or source content.' },
        },
      },
      execute: async (input) => {
        const query = optionalString((input as { query?: unknown } | undefined)?.query);
        const list = query ? storage.search(query) : storage.listProjects();
        return { count: list.length, projects: list.map(summarize) };
      },
    },
    {
      name: 'viz_get_project',
      description:
        'Fetch a single visualization project by id: full source, engine, outbound deep-links, and the last 10 chat messages.',
      inputSchema: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' } },
      },
      execute: async (input) => {
        const id = requireString((input as { id?: unknown }).id, 'id');
        const meta = storage.getProject(id);
        if (!meta) throw new Error(`No visualization project with id "${id}".`);
        const data = storage.readProjectData(id);
        return {
          ...meta,
          recentMessages: data.messages.slice(-10),
          revisionCount: data.revisions.length,
        };
      },
    },
    {
      name: 'viz_create_project',
      description:
        'Create a new visualization project. Provide either `source` (raw mermaid text or Chart.js JSON) or `prompt` (natural-language description the plugin will turn into a diagram). If `engine` is omitted it is inferred from `source` (JSON with type/data → chartjs, otherwise mermaid). Returns the new project id.',
      inputSchema: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string' },
          engine: { type: 'string', enum: ['mermaid', 'chartjs'] },
          source: { type: 'string', description: 'Raw diagram source. Mutually preferred over prompt.' },
          prompt: { type: 'string', description: 'Natural-language description; ignored if source is set.' },
        },
      },
      execute: async (input) => {
        const args = (input ?? {}) as Record<string, unknown>;
        const name = requireString(args.name, 'name');
        const source = optionalString(args.source);
        const prompt = optionalString(args.prompt);
        const engine = coerceEngine(args.engine, source, storage.getDefaults().engine ?? 'mermaid');

        const meta = storage.createProject({ name, engine, source });
        let generationError: string | undefined;
        if (!source && prompt) {
          storage.appendMessage(meta.id, { role: 'user', content: prompt });
          const data = storage.readProjectData(meta.id);
          const session = openFragSession(meta.id, meta.engine, data.fragments);
          try {
            const result = await runAgent(
              api,
              meta,
              data.fragments,
              storage.listProjects(),
              [],
              prompt,
              storage.getDefaults(),
            );
            const assistantMsg = storage.appendMessage(meta.id, {
              role: 'assistant',
              content: result.text,
            });
            if (session.dirty) {
              const rev = storage.addRevision(meta.id, {
                engine: session.engine,
                source: composeSession(session),
                fragments: session.fragments,
                author: 'tool',
                messageId: assistantMsg.id,
              });
              storage.updateMessage(meta.id, assistantMsg.id, { revisionId: rev.id });
            }
          } catch (e) {
            generationError = e instanceof Error ? e.message : String(e);
            storage.appendMessage(meta.id, { role: 'assistant', content: '', error: generationError });
            api.log.warn('viz_create_project: prompt generation failed', e);
          } finally {
            closeFragSession(meta.id);
          }
        } else if (source) {
          storage.addRevision(meta.id, { engine, source, author: 'tool' });
        }
        publish();
        const final = storage.getProject(meta.id)!;
        return {
          id: final.id,
          name: final.name,
          engine: final.engine,
          ...(generationError ? { generationError } : {}),
        };
      },
    },
    {
      name: 'viz_update_project',
      description:
        'Update a visualization project. Supplying `source` creates a new revision and re-derives outbound links. To deep-link a specific node to another project, embed `click <NodeId> href "viz://<targetProjectId>#<optionalNodeId>"` in the mermaid source (or `"_links": {"<ds>.<idx>": "viz://<targetProjectId>"}` in chartjs JSON).',
      inputSchema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          engine: { type: 'string', enum: ['mermaid', 'chartjs'] },
          source: { type: 'string' },
        },
      },
      execute: async (input) => {
        const args = (input ?? {}) as Record<string, unknown>;
        const id = requireString(args.id, 'id');
        const existing = storage.getProject(id);
        if (!existing) throw new Error(`No visualization project with id "${id}".`);

        const name = optionalString(args.name);
        if (name && name.trim()) storage.updateProject(id, { name: name.trim() });

        const source = optionalString(args.source);
        if (source !== undefined) {
          const engine = coerceEngine(args.engine, source, existing.engine);
          storage.addRevision(id, { engine, source, author: 'tool' });
        } else if (args.engine !== undefined) {
          if (!isEngine(args.engine)) throw new Error(`"engine" must be one of: mermaid, chartjs.`);
          // Engine change is a revision so head/undo stay consistent.
          storage.addRevision(id, { engine: args.engine, source: existing.source, author: 'tool' });
        }
        publish();
        return summarize(storage.getProject(id)!);
      },
    },
    {
      name: 'viz_duplicate_project',
      description:
        'Clone a visualization project (source, engine, chat history, and full revision tree). Returns the new project id.',
      inputSchema: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' } },
      },
      execute: async (input) => {
        const id = requireString((input as { id?: unknown }).id, 'id');
        const copy = storage.duplicateProject(id);
        if (!copy) throw new Error(`No visualization project with id "${id}".`);
        publish();
        return { id: copy.id, name: copy.name, engine: copy.engine };
      },
    },
    {
      name: 'viz_delete_project',
      description: 'Permanently delete a visualization project and its chat/revision history.',
      inputSchema: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string' } },
      },
      execute: async (input) => {
        const id = requireString((input as { id?: unknown }).id, 'id');
        if (!storage.getProject(id)) throw new Error(`No visualization project with id "${id}".`);
        abortForProject(id);
        storage.deleteProject(id);
        publish();
        return { deleted: true, id };
      },
    },
  ];
}
