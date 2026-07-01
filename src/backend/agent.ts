import type {
  PluginAPI,
  ProjectMeta,
  Message,
  Fragment,
  VizDefaults,
  PluginAgentMessage,
  PluginAgentGenerateResult,
} from '../shared/types.js';
import { DEFAULT_MAX_HISTORY_MESSAGES } from '../shared/constants.js';
import { summarizeFragments } from './fragments.js';

const FENCE_RE = /```(mermaid|chartjs|json)\s*\r?\n([\s\S]*?)```/gi;

/** Remove fenced diagram blocks so the chat bubble shows only prose. */
export function stripFencedBlocks(text: string): string {
  return text.replace(FENCE_RE, '').replace(/\n{3,}/g, '\n\n').trim();
}

/** Cheap line-set diff for the "updated" chip badge. */
export function lineDiff(before: string, after: string): { added: number; removed: number } {
  const b = before.split('\n').map((l) => l.trimEnd());
  const a = after.split('\n').map((l) => l.trimEnd());
  const bCount = new Map<string, number>();
  for (const l of b) bCount.set(l, (bCount.get(l) ?? 0) + 1);
  let matched = 0;
  for (const l of a) {
    const c = bCount.get(l) ?? 0;
    if (c > 0) {
      bCount.set(l, c - 1);
      matched++;
    }
  }
  return { added: a.length - matched, removed: b.length - matched };
}

function projectCatalog(all: ProjectMeta[], currentId: string): string {
  const others = all.filter((p) => p.id !== currentId);
  if (others.length === 0) return '(none yet)';
  return others.map((p) => `- id: ${p.id} — "${p.name}" (${p.engine})`).join('\n');
}

function fragmentTable(fragments: Fragment[]): string {
  const rows = summarizeFragments(fragments);
  if (rows.length === 0) return '(empty project — no fragments yet)';
  return rows
    .map((r) => `- ${r.name}  (${r.lines} lines, ${r.bytes} bytes)  — starts: ${r.head || '(empty)'}`)
    .join('\n');
}

export function buildSystemPrompt(
  project: ProjectMeta,
  fragments: Fragment[],
  allProjects: ProjectMeta[],
): string {
  const totalLines = fragments.reduce((n, f) => n + (f.source ? f.source.split('\n').length : 0), 0);
  const inlineHint =
    totalLines <= 40 && fragments.length === 1
      ? `\n\nBecause the diagram is small, here is the current source of fragment "${fragments[0].name}" for convenience (you may still use tools):\n\`\`\`${project.engine}\n${fragments[0].source}\n\`\`\``
      : '';

  return `You are a diagram & chart authoring agent embedded in a visualization tool. You operate like a code editor on a small virtual filesystem of source *fragments* that concatenate (in listed order, separated by mermaid comment markers) to form the rendered diagram.

## This project
- name: "${project.name}"
- projectId: **${project.id}**  ← pass this to every viz_frag_* tool call
- engine: ${project.engine}  (mermaid = ERDs/flowcharts/sequence/class/state/C4/gantt; chartjs = bar/line/pie JSON)
- fragments (${fragments.length}, ${totalLines} total lines):
${fragmentTable(fragments)}${inlineHint}

## Your tools (use these instead of echoing full source)
- \`viz_frag_list\` — see fragment names/sizes (call first if unsure what exists)
- \`viz_frag_read\` — read one fragment's source
- \`viz_frag_grep\` — search across fragments (find where a node/style/edge lives)
- \`viz_frag_patch\` — surgical search/replace in one fragment (preferred for small edits)
- \`viz_frag_write\` — overwrite one fragment (structural changes / first draft)
- \`viz_frag_create\` / \`viz_frag_delete\` / \`viz_frag_rename\` — manage fragments
- \`viz_frag_set_engine\` — switch mermaid ↔ chartjs

Workflow: read only what you need (grep or read specific fragments), then patch/write. Every mutating tool returns a \`validation\` result — if \`valid: false\`, the composed diagram no longer parses; **fix it before finishing** (the error and line number are in the result). You may also call \`viz_frag_validate\` explicitly. Do NOT dump the whole diagram back in your text reply — your tool calls are the edit; your text reply is a short natural-language summary of what changed (or an answer, if the user asked a question that needs no edit).

## Composition
Fragments concatenate in order. A sensible split: one fragment for the diagram header + node declarations, one for edges, one for subgraphs, one for \`style\`/\`classDef\`. You may reorganize with create/delete/rename if it helps.

## Deep linking
Other visualization projects you can link nodes into:
${projectCatalog(allProjects, project.id)}

Mermaid: \`click <NodeId> href "viz://<projectId>#<optionalTargetNodeId>" "Open <name>"\`.
Chart.js: top-level \`"_links": {"<datasetIdx>.<pointIdx>": "viz://<projectId>#<optionalNode>"}\`.

## Mermaid guidelines
- Valid syntax only. Clear alphanumeric node ids (linkable).
- Multi-line labels use \`<br/>\`, never \\n.
- Avoid raw HTML in labels (renderer uses SVG text mode).

If the user's message is a question that does not require changing the diagram, answer without calling write/patch tools.`;
}

export type AgentRunResult = {
  text: string;
  toolCalls: PluginAgentGenerateResult['toolCalls'];
  modelKey: string;
};

export async function runAgent(
  api: PluginAPI,
  project: ProjectMeta,
  fragments: Fragment[],
  allProjects: ProjectMeta[],
  history: Message[],
  userText: string,
  defaults: VizDefaults,
  abortSignal?: AbortSignal,
): Promise<AgentRunResult> {
  const maxHistory = defaults.maxHistoryMessages ?? DEFAULT_MAX_HISTORY_MESSAGES;
  const recent = history.filter((m) => !m.error).slice(-maxHistory);

  const messages: PluginAgentMessage[] = [
    { role: 'system', content: buildSystemPrompt(project, fragments, allProjects) },
    ...recent.map((m) => ({ role: m.role, content: m.content }) as PluginAgentMessage),
    { role: 'user', content: userText },
  ];

  const result = await api.agent.generate({
    messages,
    modelKey: defaults.modelOverride,
    tools: true,
    abortSignal,
  });

  return { text: result.text, toolCalls: result.toolCalls ?? [], modelKey: result.modelKey };
}
