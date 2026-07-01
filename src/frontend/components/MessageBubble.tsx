import React from 'react';
import type { Message } from '../../shared/types.js';
import { ToolCallTrace } from './ToolCallTrace';

const FENCE_RE = /```(mermaid|chartjs|json)\s*\r?\n[\s\S]*?```/gi;

function stripFences(text: string): string {
  return text.replace(FENCE_RE, '').replace(/\n{3,}/g, '\n\n').trim();
}

type Props = {
  message: Message;
  pending?: boolean;
  onRetry?: (messageId: string) => void;
};

export function MessageBubble({ message, pending, onRetry }: Props) {
  const isUser = message.role === 'user';
  const display = isUser ? message.content : stripFences(message.content);

  return (
    <div
      className={`flex min-w-0 flex-col gap-1.5 ${isUser ? 'items-end' : 'items-start'}`}
      style={{ maxWidth: '100%' }}
    >
      {!isUser && message.toolCalls && message.toolCalls.length > 0 ? (
        <div style={{ width: '100%' }}>
          <ToolCallTrace calls={message.toolCalls} />
        </div>
      ) : null}
      <div
        className={`rounded-2xl px-3.5 py-2.5 text-sm ${
          isUser
            ? 'bg-primary text-primary-foreground'
            : message.error
              ? 'border border-destructive/50 bg-destructive/10 text-destructive'
              : 'border border-border/50 bg-card/80'
        }`}
        style={{
          maxWidth: '85%',
          minWidth: 0,
          whiteSpace: 'pre-wrap',
          overflowWrap: 'anywhere',
          wordBreak: 'break-word',
        }}
      >
        {message.error ? (
          <div className="space-y-2">
            <div>⚠ {message.error}</div>
            {display ? <div className="opacity-80">{display}</div> : null}
            {onRetry ? (
              <button
                type="button"
                disabled={pending}
                onClick={() => onRetry(message.id)}
                className="rounded-lg border border-destructive/60 px-2.5 py-1 text-xs font-medium hover:bg-destructive/20 disabled:opacity-40"
              >
                Retry
              </button>
            ) : null}
          </div>
        ) : display ? (
          display
        ) : (
          <span className="text-muted-foreground italic">(no text)</span>
        )}
      </div>
      {!isUser && !message.error && message.revisionId ? (
        <div
          className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/15 px-2 py-0.5 font-medium text-emerald-600 dark:text-emerald-400"
          style={{ fontSize: '11px' }}
        >
          ✓ Diagram updated
          {message.diff ? (
            <span className="opacity-80">
              (+{message.diff.added}/−{message.diff.removed})
            </span>
          ) : null}
        </div>
      ) : null}
      {!isUser && message.warning ? (
        <div
          className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/15 px-2 py-0.5 font-medium text-amber-600 dark:text-amber-400"
          style={{ fontSize: '11px', maxWidth: '100%' }}
        >
          ⚠ {message.warning}
        </div>
      ) : null}
    </div>
  );
}
