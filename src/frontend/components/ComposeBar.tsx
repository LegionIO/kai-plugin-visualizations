import React, { useState, useCallback, useRef, useEffect } from 'react';

type Props = {
  disabled?: boolean;
  pending?: boolean;
  placeholder?: string;
  onSend: (text: string) => void;
  onAbort: () => void;
};

export function ComposeBar({ disabled, pending, placeholder, onSend, onAbort }: Props) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 160) + 'px';
  }, [text]);

  const send = useCallback(() => {
    const t = text.trim();
    if (!t || disabled || pending) return;
    onSend(t);
    setText('');
  }, [text, disabled, pending, onSend]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    },
    [send],
  );

  return (
    <div className="flex items-end gap-2 border-t border-border/50 bg-background/80 p-3">
      <textarea
        ref={ref}
        rows={1}
        value={text}
        disabled={disabled}
        placeholder={placeholder ?? 'Describe what to create or change…'}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        className="flex-1 resize-none rounded-xl border border-border/70 bg-card/80 px-3 py-2 text-sm outline-none focus:border-primary/60 disabled:opacity-50"
        style={{ minHeight: '38px', maxHeight: '160px', minWidth: 0 }}
      />
      {pending ? (
        <button
          type="button"
          onClick={onAbort}
          title="Stop generating"
          className="rounded-xl border border-border/70 bg-card/80 px-3 text-xs font-medium hover:bg-muted/50"
          style={{ height: '38px' }}
        >
          Stop
        </button>
      ) : (
        <button
          type="button"
          onClick={send}
          disabled={disabled || !text.trim()}
          className="rounded-xl bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-40"
          style={{ height: '38px' }}
        >
          Send
        </button>
      )}
    </div>
  );
}
