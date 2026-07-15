import type { PluginAPI, ToolDefinition, Engine, ProjectMeta, MermaidLook, MermaidCurve } from '../shared/types.js';
import { VizStorage, isEngine, inferEngine } from './storage.js';
import { runAgent } from './agent.js';
import { openFragSession, closeFragSession, composeSession } from './frag-tools.js';
import { renderViaHiddenWindow } from './render-window.js';
import { mkdirSync, existsSync, lstatSync, realpathSync, openSync, writeSync, closeSync, renameSync, unlinkSync, constants as fsConstants } from 'fs';
import { dirname, isAbsolute, resolve as resolvePath, extname, join } from 'path';
import { homedir } from 'os';
import { randomBytes } from 'crypto';

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
  'viz_export_project',
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

/** Expand a leading ~ and resolve to an absolute path. */
function resolveExportPath(p: string): string {
  const expanded = p.startsWith('~') ? p.replace(/^~(?=$|\/)/, homedir()) : p;
  return isAbsolute(expanded) ? expanded : resolvePath(process.cwd(), expanded);
}

/**
 * Write image bytes to a model-supplied path, guarding against clobbering
 * arbitrary files. The path is chosen by the model (which may be steered by
 * untrusted diagram content), so:
 *  - reject a symlink at the destination outright (via lstat, cross-platform —
 *    O_NOFOLLOW is ignored on Windows),
 *  - refuse to overwrite an existing file whose extension isn't the image
 *    format we're producing (don't turn someone's config into PNG bytes),
 *  - reject a symlinked immediate parent (and grandparent when creating it) and
 *    create at most one new directory (no deep arbitrary trees),
 *  - write to a same-dir temp file (fully, looping past short writes) then
 *    atomically rename over the destination, so a failed/partial write can't
 *    truncate or corrupt an existing export.
 */
function writeExportFile(dest: string, ext: 'png' | 'svg', bytes: Buffer): void {
  if (existsSync(dest)) {
    const st = lstatSync(dest);
    if (st.isSymbolicLink()) {
      throw new Error(`Refusing to write through a symlink: "${dest}".`);
    }
    if (!st.isFile()) {
      throw new Error(`Refusing to overwrite non-regular file: "${dest}".`);
    }
    if (extname(dest).toLowerCase() !== `.${ext}`) {
      throw new Error(
        `Refusing to overwrite existing "${dest}" (not a .${ext} file). Choose a new path or a .${ext} name.`,
      );
    }
  }

  // Guard the destination's immediate parent (the component closest to the
  // model-controlled leaf, where a planted symlink would redirect the write).
  // We deliberately don't walk to the filesystem root — legitimate setups have
  // symlinked ancestors (e.g. /tmp→/private/tmp on macOS, symlinked home dirs)
  // that are not an attack. Create at most one new directory.
  const parent = dirname(dest);
  if (existsSync(parent)) {
    if (lstatSync(parent).isSymbolicLink()) {
      throw new Error(`Refusing to write through a symlinked directory: "${parent}".`);
    }
  } else {
    const grandparent = dirname(parent);
    if (parent !== grandparent && !existsSync(grandparent)) {
      throw new Error(`Destination directory "${parent}" does not exist (create it first).`);
    }
    if (existsSync(grandparent) && lstatSync(grandparent).isSymbolicLink()) {
      throw new Error(`Refusing to write through a symlinked directory: "${grandparent}".`);
    }
    mkdirSync(parent); // non-recursive
  }

  // Best-effort TOCTOU narrowing: resolve the parent's real path now and again
  // right before writing; if any component became a symlink (or the resolved
  // location changed) between the lstat above and the write, bail. This can't
  // fully close the race without fd-relative (openat) writes Node doesn't
  // expose, but it shrinks the window to the gap between these two calls.
  const parentReal = realpathSync(parent);
  if (lstatSync(parentReal).isSymbolicLink()) {
    throw new Error(`Refusing to write through a symlinked directory: "${parent}".`);
  }

  // Write to a same-directory temp file, fully, then atomically rename over the
  // destination. This avoids O_TRUNC destroying an existing file before a write
  // that might fail (ENOSPC/quota), and the write loop guards against short
  // writeSync returns leaving a truncated image reported as success.
  const tmp = join(parent, `.viz-export-${randomBytes(6).toString('hex')}.tmp`);
  // Re-verify the parent hasn't been swapped for a symlink since parentReal.
  if (realpathSync(parent) !== parentReal || lstatSync(parent).isSymbolicLink()) {
    throw new Error(`Destination directory "${parent}" changed during write; aborting.`);
  }
  // O_EXCL|O_NOFOLLOW: fail rather than follow/clobber if something exists at
  // the temp path (it shouldn't — the name is random).
  const fd = openSync(
    tmp,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
    0o644,
  );
  try {
    let offset = 0;
    while (offset < bytes.length) {
      offset += writeSync(fd, bytes, offset, bytes.length - offset);
    }
  } catch (e) {
    closeSync(fd);
    try { unlinkSync(tmp); } catch { /* best effort */ }
    throw e;
  }
  closeSync(fd);
  try {
    renameSync(tmp, dest);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* best effort */ }
    throw e;
  }
}

/** A model-visible content part carried on a tool result (see host tool-model-content). */
type ModelContentPart =
  | { type: 'image'; data: string; mediaType: string }
  | { type: 'file'; data: string; mediaType: string; filename?: string };

/**
 * The app's theme preference, for "match"-style exports. 'system' can't be
 * resolved to the OS preference from the backend, so we hand that decision to
 * the renderer (which has matchMedia). 'dark'|'light' are honored directly;
 * anything unreadable falls back to 'dark' (the panel's default canvas).
 */
function appTheme(api: PluginAPI): 'dark' | 'light' | 'system' {
  try {
    const t = (api.config.get() as { ui?: { theme?: unknown } })?.ui?.theme;
    return t === 'light' || t === 'system' ? t : 'dark';
  } catch {
    return 'dark';
  }
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
    {
      name: 'viz_export_project',
      description:
        'Render a visualization project to an actual image so you can SEE it — the rendered diagram/chart is returned inline as an image you can inspect. ' +
        'Rendering happens headlessly in the background (nothing is shown to the user). ' +
        'Omit `path` to just get the image back; pass `path` to ALSO save it to a file on disk. ' +
        'PNG works for both engines; SVG is mermaid-only. Set `returnImage:false` to write the file without returning the (large) image inline. ' +
        'By default the export matches the workspace style; pass `style` to force "neo" or "plain".',
      inputSchema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', description: 'The visualization project id.' },
          format: {
            type: 'string',
            enum: ['png', 'svg'],
            description: 'Image format (default png). svg is only valid for mermaid diagrams.',
          },
          path: {
            type: 'string',
            description: 'Optional file path to write the image to (absolute or ~-relative). If omitted, the image is only returned inline.',
          },
          style: {
            type: 'string',
            enum: ['match', 'neo', 'plain'],
            description:
              'Visual style of the export (default "match"). "match" uses this workspace\'s saved look/theme so the image matches what the panel shows. "neo" forces the polished dark neon look. "plain" uses a clean classic look on a light background.',
          },
          scale: {
            type: 'number',
            description: 'PNG supersampling factor for mermaid (default 2). Higher = sharper/larger.',
          },
          returnImage: {
            type: 'boolean',
            description: 'Whether to return the image inline to you (default true). Set false to only write the file.',
          },
        },
      },
      execute: async (input, context) => {
        const abortSignal = (context as { abortSignal?: AbortSignal } | undefined)?.abortSignal;
        const args = (input ?? {}) as Record<string, unknown>;
        const id = requireString(args.id, 'id');
        const meta = storage.getProject(id);
        if (!meta) throw new Error(`No visualization project with id "${id}".`);
        if (!meta.source.trim()) {
          throw new Error(`Project "${meta.name}" has no source to render yet.`);
        }

        const format = args.format === 'svg' ? 'svg' : 'png';
        if (format === 'svg' && meta.engine === 'chartjs') {
          throw new Error('SVG export is only supported for mermaid diagrams; use format "png" for charts.');
        }
        const returnImage = args.returnImage !== false;

        const hasPath = typeof args.path === 'string' && args.path.trim().length > 0;
        // Rendering is the expensive step — reject a no-op request (nothing
        // returned, nothing saved) before doing it, rather than discarding the
        // bytes and reporting a hollow success.
        if (!returnImage && !hasPath) {
          throw new Error('Nothing to do: set returnImage:true to get the image inline, or provide a path to save it.');
        }
        // If saving, the path's extension must match the format so we never
        // write PNG bytes into a ".svg"/extensionless name (or vice-versa).
        // Required unconditionally (even for a new/nonexistent path).
        if (hasPath) {
          const pathExt = extname((args.path as string).trim()).toLowerCase();
          if (pathExt !== `.${format}`) {
            throw new Error(`Path must end in ".${format}" to match the export format (got "${pathExt || 'no extension'}").`);
          }
        }

        const scale =
          typeof args.scale === 'number' && Number.isFinite(args.scale)
            ? Math.min(Math.max(args.scale, 1), 4)
            : 2;

        if (args.style !== undefined && args.style !== 'match' && args.style !== 'neo' && args.style !== 'plain') {
          throw new Error('"style" must be one of: match, neo, plain.');
        }
        const style = (args.style as 'match' | 'neo' | 'plain' | undefined) ?? 'match';

        const defaults = storage.getDefaults();
        // Resolve the visual style:
        //  - match: mirror the live panel — same look fallback (classic) and the
        //    same light/dark mode the app is in.
        //  - neo: force the polished dark neon look.
        //  - plain: clean classic look on a light background.
        let look: MermaidLook;
        let isDark = true;
        let resolveSystemDark = false;
        // match honors the source's own %%{init}%% directives (mirrors the
        // panel); neo/plain force the style, so lock those directives out.
        const lockStyle = style !== 'match';
        if (style === 'neo') {
          look = 'neo';
          isDark = true;
        } else if (style === 'plain') {
          look = 'classic';
          isDark = false;
        } else {
          // match: the panel defaults mermaidLook to 'classic' when unset, and
          // renders in whatever theme the app is using.
          look = defaults.mermaidLook ?? 'classic';
          const theme = appTheme(api);
          if (theme === 'system') {
            resolveSystemDark = true; // renderer resolves via matchMedia
          } else {
            isDark = theme === 'dark';
          }
        }
        const curve: MermaidCurve = defaults.mermaidCurve ?? 'basis';

        const { base64, mediaType } = await renderViaHiddenWindow(
          api,
          {
            engine: meta.engine,
            source: meta.source,
            format,
            look,
            curve,
            isDark,
            resolveSystemDark,
            lockStyle,
            scale,
          },
          abortSignal,
        );

        const bytes = Math.floor((base64.length * 3) / 4);

        let savedTo: string | undefined;
        if (hasPath) {
          if (abortSignal?.aborted) throw new Error('Export cancelled.');
          const dest = resolveExportPath((args.path as string).trim());
          try {
            writeExportFile(dest, format, Buffer.from(base64, 'base64'));
            savedTo = dest;
          } catch (e) {
            throw new Error(`Failed to write image to "${dest}": ${e instanceof Error ? e.message : String(e)}`);
          }
        }

        const filename = `${meta.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'diagram'}.${format === 'svg' ? 'svg' : 'png'}`;

        // The host drops any single _modelContent part over 5 MiB (decoded) and
        // replaces it with an "omitted" note — so an oversized inline image is a
        // silent no-op for the assistant. Detect that here rather than returning
        // a hollow success: if it was saved, report the file and skip the inline
        // image; otherwise tell the caller how to get it (save to a path, or
        // lower `scale`).
        const HOST_PART_LIMIT = 5 * 1024 * 1024;
        const tooLargeToInline = returnImage && bytes > HOST_PART_LIMIT;
        if (tooLargeToInline && !savedTo) {
          throw new Error(
            `Rendered ${format.toUpperCase()} is ${(bytes / (1024 * 1024)).toFixed(1)} MB, over the ${(HOST_PART_LIMIT / (1024 * 1024)).toFixed(0)} MB inline limit. Save it to a file (pass \`path\`)${format === 'png' ? ' or lower `scale`' : ''} instead.`,
          );
        }
        const inlineImage = returnImage && !tooLargeToInline;
        const modelContent: ModelContentPart[] = inlineImage
          ? [
              format === 'svg'
                ? { type: 'file', data: base64, mediaType, filename }
                : { type: 'image', data: base64, mediaType },
            ]
          : [];

        return {
          success: true,
          id: meta.id,
          name: meta.name,
          engine: meta.engine,
          format,
          mediaType,
          bytes,
          ...(savedTo ? { savedTo } : {}),
          ...(tooLargeToInline
            ? { imageOmitted: `Image too large to return inline (${(bytes / (1024 * 1024)).toFixed(1)} MB); saved to file only.` }
            : {}),
          ...(inlineImage ? { _modelContent: modelContent } : {}),
        };
      },
    },
  ];
}
