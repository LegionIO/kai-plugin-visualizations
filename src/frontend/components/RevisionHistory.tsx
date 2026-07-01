import React, { useMemo } from 'react';
import type { Revision } from '../../shared/types.js';

type Props = {
  revisions: Revision[];
  headId?: string;
  onCheckout: (revisionId: string) => void;
};

type TreeNode = {
  rev: Revision;
  depth: number;
  onHeadPath: boolean;
  isBranchTip: boolean;
  branchNumber: number;
};

function relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.round(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}

/**
 * Flatten the revision DAG into a depth-first list rooted at revisions with no parent.
 * At each fork, the child that leads toward `headId` is visited first.
 */
function buildTree(revisions: Revision[], headId?: string): { rows: TreeNode[]; branchCount: number } {
  const byId = new Map(revisions.map((r) => [r.id, r]));
  const children = new Map<string | undefined, Revision[]>();
  for (const r of revisions) {
    const key = r.parentId;
    if (!children.has(key)) children.set(key, []);
    children.get(key)!.push(r);
  }
  for (const list of children.values()) {
    list.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  }

  const headPath = new Set<string>();
  let cursor = headId;
  while (cursor) {
    headPath.add(cursor);
    cursor = byId.get(cursor)?.parentId;
  }

  const tips = new Set(revisions.filter((r) => !(children.get(r.id)?.length)).map((r) => r.id));

  const rows: TreeNode[] = [];
  let branchCounter = 0;

  const walk = (rev: Revision, depth: number, branchNumber: number) => {
    rows.push({
      rev,
      depth,
      onHeadPath: headPath.has(rev.id),
      isBranchTip: tips.has(rev.id),
      branchNumber,
    });
    const kids = [...(children.get(rev.id) ?? [])];
    kids.sort((a, b) => {
      const ah = headPath.has(a.id) ? 0 : 1;
      const bh = headPath.has(b.id) ? 0 : 1;
      if (ah !== bh) return ah - bh;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
    kids.forEach((k, i) => {
      const bn = i === 0 ? branchNumber : ++branchCounter;
      walk(k, depth + 1, bn);
    });
  };

  for (const root of children.get(undefined) ?? []) {
    walk(root, 0, ++branchCounter);
  }

  return { rows, branchCount: branchCounter };
}

const BRANCH_COLORS = [
  'bg-primary',
  'bg-emerald-500',
  'bg-amber-500',
  'bg-fuchsia-500',
  'bg-sky-500',
  'bg-rose-500',
];

export function RevisionHistory({ revisions, headId, onCheckout }: Props) {
  const { rows, branchCount } = useMemo(() => buildTree(revisions, headId), [revisions, headId]);

  if (rows.length === 0) {
    return <div className="p-6 text-center text-sm text-muted-foreground">No revisions yet.</div>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b border-border/40 px-4 py-2 text-[11px] text-muted-foreground">
        <span>
          {revisions.length} revision{revisions.length === 1 ? '' : 's'} · {branchCount} branch
          {branchCount === 1 ? '' : 'es'}
        </span>
        <span>Click any node to check it out</span>
      </div>
      <div className="flex-1 overflow-y-auto">
        {rows.map(({ rev, depth, onHeadPath, isBranchTip, branchNumber }) => {
          const isHead = rev.id === headId;
          const dot = BRANCH_COLORS[(branchNumber - 1) % BRANCH_COLORS.length];
          const preview = rev.source.split('\n').slice(0, 2).join('\n');
          return (
            <div
              key={rev.id}
              className={`group border-b border-border/30 px-4 py-2.5 ${
                isHead ? 'bg-primary/10' : onHeadPath ? 'bg-muted/20' : ''
              }`}
            >
              <div className="flex items-center gap-2">
                <div style={{ paddingLeft: `${depth * 14}px` }} className="flex items-center gap-2">
                  <span
                    className={`inline-block h-2.5 w-2.5 rounded-full ${dot} ${
                      onHeadPath ? '' : 'opacity-50'
                    }`}
                    title={`Branch ${branchNumber}`}
                  />
                  <span className="rounded-full bg-muted/60 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    {rev.author}
                  </span>
                  <span className="text-[10px] text-muted-foreground">{rev.engine}</span>
                  <span className="text-xs">{relTime(rev.createdAt)}</span>
                  {isHead ? (
                    <span className="rounded-full bg-primary/20 px-2 py-0.5 text-[10px] font-medium text-primary">
                      HEAD
                    </span>
                  ) : isBranchTip ? (
                    <span className="rounded-full bg-muted/60 px-2 py-0.5 text-[10px] text-muted-foreground">
                      tip
                    </span>
                  ) : null}
                </div>
                <div className="ml-auto">
                  {!isHead ? (
                    <button
                      type="button"
                      onClick={() => onCheckout(rev.id)}
                      className="rounded-lg border border-border/70 px-2.5 py-1 text-[11px] opacity-0 hover:bg-muted/50 group-hover:opacity-100"
                    >
                      Checkout
                    </button>
                  ) : null}
                </div>
              </div>
              <pre
                style={{ marginLeft: `${depth * 14 + 18}px` }}
                className="mt-1.5 max-h-16 overflow-hidden rounded bg-muted/30 p-1.5 font-mono text-[10px] leading-tight text-muted-foreground"
              >
                {preview}
                {rev.source.split('\n').length > 2 ? '\n…' : ''}
              </pre>
            </div>
          );
        })}
      </div>
    </div>
  );
}
