import type { Fragment, ToolDefinition, Engine } from '../shared/types.js';
import { newFragment, summarizeFragments, grepFragments, composeFragments } from './fragments.js';
import { applyPatch } from './patch.js';
import { validateSource, type ValidationResult } from './validate.js';

/**
 * Per-generation staging area: a working copy of a project's fragments that
 * frag_* tools mutate. Committed to a revision after the agent loop completes.
 */
export type FragSession = {
  projectId: string;
  engine: Engine;
  fragments: Fragment[];
  dirty: boolean;
  log: string[];
  lastValidation?: ValidationResult;
  /**
   * True for transient sessions built from committed project data when no live
   * edit session is open (see FragSessionResolver). Used only to tell callers
   * whether a read reflects this turn's staged edits or the saved diagram.
   */
  committed?: boolean;
};

/**
 * Builds a transient session from committed project storage when no live edit
 * session is open. Lets inspection tools (list/read/grep/validate) work outside
 * an agent turn by reading the saved diagram.
 */
export type FragSessionResolver = (projectId: string) => FragSession | undefined;

async function validateSession(s: FragSession): Promise<ValidationResult> {
  const result = await validateSource(s.engine, composeFragments(s.fragments));
  s.lastValidation = result;
  return result;
}

function withHint(v: ValidationResult): ValidationResult & { hint?: string } {
  if (v.valid) return v;
  return {
    ...v,
    hint: 'The composed diagram is now invalid. Fix it (viz_frag_patch or viz_frag_write) before finishing — line numbers refer to the fully composed source across all fragments.',
  };
}

const sessions = new Map<string, FragSession>();

export function openFragSession(projectId: string, engine: Engine, fragments: Fragment[]): FragSession {
  const sess: FragSession = {
    projectId,
    engine,
    fragments: fragments.map((f) => ({ ...f })),
    dirty: false,
    log: [],
  };
  sessions.set(projectId, sess);
  return sess;
}

export function getFragSession(projectId: string): FragSession | undefined {
  return sessions.get(projectId);
}

export function closeFragSession(projectId: string): FragSession | undefined {
  const s = sessions.get(projectId);
  sessions.delete(projectId);
  return s;
}

function requireSession(projectId: unknown): FragSession {
  if (typeof projectId !== 'string') throw new Error('projectId is required.');
  const s = sessions.get(projectId);
  if (!s) throw new Error(`No active edit session for project "${projectId}".`);
  return s;
}

function findFragment(s: FragSession, name: unknown): Fragment {
  if (typeof name !== 'string' || !name.trim()) throw new Error('fragment name is required.');
  const f = s.fragments.find((x) => x.name === name);
  if (!f) {
    const names = s.fragments.map((x) => x.name).join(', ');
    throw new Error(`Fragment "${name}" not found. Existing fragments: ${names || '(none)'}.`);
  }
  return f;
}

export const FRAG_TOOL_NAMES = [
  'viz_frag_list',
  'viz_frag_read',
  'viz_frag_grep',
  'viz_frag_write',
  'viz_frag_patch',
  'viz_frag_create',
  'viz_frag_delete',
  'viz_frag_rename',
  'viz_frag_set_engine',
  'viz_frag_validate',
] as const;

export function buildFragTools(resolveReadSession?: FragSessionResolver): ToolDefinition[] {
  /**
   * For read-only tools: prefer the live edit session; otherwise fall back to a
   * transient session built from committed storage so validate/list/read/grep
   * work outside an agent turn. Only throws if the project truly has no data.
   */
  function requireReadSession(projectId: unknown): FragSession {
    if (typeof projectId !== 'string') throw new Error('projectId is required.');
    const live = sessions.get(projectId);
    if (live) return live;
    const transient = resolveReadSession?.(projectId);
    if (!transient) throw new Error(`No active edit session for project "${projectId}".`);
    return transient;
  }

  /** Provenance note for read tools: this turn's staged edits vs the saved diagram. */
  const source = (s: FragSession): 'session' | 'committed' => (s.committed ? 'committed' : 'session');

  return [
    {
      name: 'viz_frag_list',
      description:
        'List the source fragments (virtual files) of the current visualization project: name, line/byte count, and first line. Always call this first to see what exists before reading or editing.',
      inputSchema: {
        type: 'object',
        required: ['projectId'],
        properties: { projectId: { type: 'string' } },
      },
      execute: async (input) => {
        const s = requireReadSession((input as { projectId?: unknown }).projectId);
        return { engine: s.engine, fragments: summarizeFragments(s.fragments), source: source(s) };
      },
    },
    {
      name: 'viz_frag_read',
      description:
        'Read the full source of one fragment by name. Use this before patching so your SEARCH text matches exactly.',
      inputSchema: {
        type: 'object',
        required: ['projectId', 'name'],
        properties: { projectId: { type: 'string' }, name: { type: 'string' } },
      },
      execute: async (input) => {
        const args = input as { projectId?: unknown; name?: unknown };
        const s = requireReadSession(args.projectId);
        const f = findFragment(s, args.name);
        return { name: f.name, source: f.source, from: source(s) };
      },
    },
    {
      name: 'viz_frag_grep',
      description:
        'Search across all fragments for a substring or regex. Returns matching lines with fragment name and 1-based line number. Use this to locate where a node/style/edge is defined without reading everything.',
      inputSchema: {
        type: 'object',
        required: ['projectId', 'pattern'],
        properties: {
          projectId: { type: 'string' },
          pattern: { type: 'string' },
          regex: { type: 'boolean', description: 'Treat pattern as a JS regex. Default false (substring).' },
          caseSensitive: { type: 'boolean', description: 'Default false.' },
        },
      },
      execute: async (input) => {
        const args = input as {
          projectId?: unknown;
          pattern?: unknown;
          regex?: unknown;
          caseSensitive?: unknown;
        };
        const s = requireReadSession(args.projectId);
        if (typeof args.pattern !== 'string' || !args.pattern) throw new Error('pattern is required.');
        const matches = grepFragments(s.fragments, args.pattern, {
          regex: args.regex === true,
          caseSensitive: args.caseSensitive === true,
        });
        return { matchCount: matches.length, matches, source: source(s) };
      },
    },
    {
      name: 'viz_frag_write',
      description:
        'Overwrite one fragment with new source. Use for large/structural changes or when creating the first diagram. For small tweaks prefer viz_frag_patch.',
      inputSchema: {
        type: 'object',
        required: ['projectId', 'name', 'source'],
        properties: {
          projectId: { type: 'string' },
          name: { type: 'string' },
          source: { type: 'string' },
        },
      },
      execute: async (input) => {
        const args = input as { projectId?: unknown; name?: unknown; source?: unknown };
        const s = requireSession(args.projectId);
        const f = findFragment(s, args.name);
        if (typeof args.source !== 'string') throw new Error('source must be a string.');
        f.source = args.source;
        s.dirty = true;
        s.log.push(`write ${f.name} (${args.source.split('\n').length} lines)`);
        const validation = await validateSession(s);
        return {
          ok: true,
          name: f.name,
          lines: args.source.split('\n').length,
          validation: withHint(validation),
        };
      },
    },
    {
      name: 'viz_frag_patch',
      description:
        'Apply a single search/replace edit to one fragment. `search` must appear exactly once (whitespace-normalized fallback is attempted). Prefer this for surgical edits — it is cheap and precise.',
      inputSchema: {
        type: 'object',
        required: ['projectId', 'name', 'search', 'replace'],
        properties: {
          projectId: { type: 'string' },
          name: { type: 'string' },
          search: { type: 'string', description: 'Exact text currently in the fragment.' },
          replace: { type: 'string', description: 'Text to replace it with.' },
        },
      },
      execute: async (input) => {
        const args = input as {
          projectId?: unknown;
          name?: unknown;
          search?: unknown;
          replace?: unknown;
        };
        const s = requireSession(args.projectId);
        const f = findFragment(s, args.name);
        if (typeof args.search !== 'string' || typeof args.replace !== 'string') {
          throw new Error('search and replace must be strings.');
        }
        const result = applyPatch(f.source, [{ search: args.search, replace: args.replace }]);
        if (!result.ok) throw new Error(result.error);
        f.source = result.source;
        s.dirty = true;
        s.log.push(`patch ${f.name}`);
        const validation = await validateSession(s);
        return { ok: true, name: f.name, validation: withHint(validation) };
      },
    },
    {
      name: 'viz_frag_create',
      description:
        'Create a new fragment. Fragments are concatenated in listed order at render time (mermaid comment markers separate them), so put node definitions before edges before styles. Use `after` to insert relative to an existing fragment; omit to append.',
      inputSchema: {
        type: 'object',
        required: ['projectId', 'name'],
        properties: {
          projectId: { type: 'string' },
          name: { type: 'string' },
          source: { type: 'string' },
          after: { type: 'string', description: 'Name of an existing fragment to insert after.' },
        },
      },
      execute: async (input) => {
        const args = input as {
          projectId?: unknown;
          name?: unknown;
          source?: unknown;
          after?: unknown;
        };
        const s = requireSession(args.projectId);
        if (typeof args.name !== 'string' || !args.name.trim()) throw new Error('name is required.');
        if (s.fragments.some((f) => f.name === args.name)) {
          throw new Error(`Fragment "${args.name}" already exists.`);
        }
        const frag = newFragment(args.name.trim(), typeof args.source === 'string' ? args.source : '');
        if (typeof args.after === 'string') {
          const idx = s.fragments.findIndex((f) => f.name === args.after);
          if (idx === -1) throw new Error(`Cannot insert after unknown fragment "${args.after}".`);
          s.fragments.splice(idx + 1, 0, frag);
        } else {
          s.fragments.push(frag);
        }
        s.dirty = true;
        s.log.push(`create ${frag.name}`);
        const validation = await validateSession(s);
        return {
          ok: true,
          name: frag.name,
          position: s.fragments.findIndex((f) => f.id === frag.id),
          validation: withHint(validation),
        };
      },
    },
    {
      name: 'viz_frag_validate',
      description:
        'Validate the composed diagram (all fragments concatenated) with the mermaid/chartjs parser. Returns {valid: true} or {valid: false, error, line}, plus `source`: "session" (this turn\'s staged edits) or "committed" (the saved diagram, when no edit is in progress). write/patch already return this automatically; use this tool to re-check after multiple edits or before finishing.',
      inputSchema: {
        type: 'object',
        required: ['projectId'],
        properties: { projectId: { type: 'string' } },
      },
      execute: async (input) => {
        const s = requireReadSession((input as { projectId?: unknown }).projectId);
        return { ...withHint(await validateSession(s)), source: source(s) };
      },
    },
    {
      name: 'viz_frag_delete',
      description: 'Delete a fragment by name. At least one fragment must remain.',
      inputSchema: {
        type: 'object',
        required: ['projectId', 'name'],
        properties: { projectId: { type: 'string' }, name: { type: 'string' } },
      },
      execute: async (input) => {
        const args = input as { projectId?: unknown; name?: unknown };
        const s = requireSession(args.projectId);
        const f = findFragment(s, args.name);
        if (s.fragments.length <= 1) throw new Error('Cannot delete the last remaining fragment.');
        s.fragments = s.fragments.filter((x) => x.id !== f.id);
        s.dirty = true;
        s.log.push(`delete ${f.name}`);
        const validation = await validateSession(s);
        return { ok: true, validation: withHint(validation) };
      },
    },
    {
      name: 'viz_frag_rename',
      description: 'Rename a fragment.',
      inputSchema: {
        type: 'object',
        required: ['projectId', 'name', 'newName'],
        properties: {
          projectId: { type: 'string' },
          name: { type: 'string' },
          newName: { type: 'string' },
        },
      },
      execute: async (input) => {
        const args = input as { projectId?: unknown; name?: unknown; newName?: unknown };
        const s = requireSession(args.projectId);
        const f = findFragment(s, args.name);
        if (typeof args.newName !== 'string' || !args.newName.trim()) throw new Error('newName is required.');
        if (s.fragments.some((x) => x.name === args.newName)) {
          throw new Error(`Fragment "${args.newName}" already exists.`);
        }
        f.name = args.newName.trim();
        s.dirty = true;
        s.log.push(`rename → ${f.name}`);
        return { ok: true };
      },
    },
    {
      name: 'viz_frag_set_engine',
      description:
        "Change this project's rendering engine. Use 'chartjs' only when the user wants a data chart (bar/line/pie); otherwise stay on 'mermaid'.",
      inputSchema: {
        type: 'object',
        required: ['projectId', 'engine'],
        properties: {
          projectId: { type: 'string' },
          engine: { type: 'string', enum: ['mermaid', 'chartjs'] },
        },
      },
      execute: async (input) => {
        const args = input as { projectId?: unknown; engine?: unknown };
        const s = requireSession(args.projectId);
        if (args.engine !== 'mermaid' && args.engine !== 'chartjs') {
          throw new Error('engine must be "mermaid" or "chartjs".');
        }
        s.engine = args.engine;
        s.dirty = true;
        s.log.push(`engine → ${s.engine}`);
        const validation = await validateSession(s);
        return { ok: true, engine: s.engine, validation: withHint(validation) };
      },
    },
  ];
}

export function composeSession(s: FragSession): string {
  return composeFragments(s.fragments);
}

export async function finalizeSession(s: FragSession): Promise<ValidationResult> {
  return s.lastValidation ?? (await validateSession(s));
}
