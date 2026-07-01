import React, { useEffect, useRef } from 'react';
import type { Message } from '../../shared/types.js';
import { MessageBubble } from './MessageBubble';
import { ComposeBar } from './ComposeBar';

type Props = {
  messages: Message[];
  pending: boolean;
  isEmpty: boolean;
  onSend: (text: string) => void;
  onAbort: () => void;
  onRetry: (messageId: string) => void;
};

export function ChatThread({ messages, pending, isEmpty, onSend, onAbort, onRetry }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, pending]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b border-border/50 px-4 py-2.5">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Chat
        </span>
        <span className="text-[10px] text-muted-foreground">{messages.length} msgs</span>
      </div>

      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto p-4" style={{ minWidth: 0 }}>
        {messages.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border/60 bg-card/40 p-4 text-center text-xs text-muted-foreground">
            {isEmpty
              ? 'Describe the diagram you want to create.'
              : 'Ask a question or request an edit.'}
          </div>
        ) : (
          messages.map((m) => (
            <MessageBubble key={m.id} message={m} pending={pending} onRetry={onRetry} />
          ))
        )}
        {pending ? (
          <div className="flex justify-start">
            <div className="rounded-2xl border border-border/50 bg-card/80 px-3.5 py-2.5 text-sm text-muted-foreground">
              <span className="inline-flex items-center gap-2">
                <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-primary" />
                Generating…
              </span>
            </div>
          </div>
        ) : null}
      </div>

      <ComposeBar
        pending={pending}
        placeholder={
          isEmpty ? 'Describe what to create (e.g. "ERD for llm-gateway service")' : undefined
        }
        onSend={onSend}
        onAbort={onAbort}
      />
    </div>
  );
}
