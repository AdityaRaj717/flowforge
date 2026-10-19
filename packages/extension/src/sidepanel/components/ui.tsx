import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import type { JobState } from '@flowforge/core';
import { STATE_LABEL } from '@flowforge/core';

const ToastCtx = createContext<(msg: string, bad?: boolean) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastHost({ children }: { children: ReactNode }) {
  const [t, setT] = useState<{ msg: string; bad?: boolean } | null>(null);
  const show = useCallback((msg: string, bad?: boolean) => {
    setT({ msg, bad });
    setTimeout(() => setT((cur) => (cur?.msg === msg ? null : cur)), bad ? 6000 : 2800);
  }, []);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      {t && (
        <div className={`toast ${t.bad ? 'bad' : ''}`} role="status" onClick={() => setT(null)}>
          {t.msg}
        </div>
      )}
    </ToastCtx.Provider>
  );
}

/** Runs an async action and reports failures as a toast instead of swallowing them. */
export function useAction() {
  const toast = useToast();
  return useCallback(
    async <T,>(fn: () => Promise<T>, ok?: string): Promise<T | undefined> => {
      try {
        const r = await fn();
        if (ok) toast(ok);
        return r;
      } catch (e) {
        toast((e as Error).message, true);
        return undefined;
      }
    },
    [toast],
  );
}

const TONE: Partial<Record<JobState, string>> = {
  succeeded: 'ok',
  preparing: 'run', submitting: 'run', generating: 'run', verifying: 'run', downloading: 'run',
  failed: 'bad', policy_blocked: 'bad', unsupported: 'bad', download_failed: 'bad', verification_failed: 'bad',
  waiting_for_user: 'warn', waiting_for_flow: 'warn', retry_wait: 'warn',
  blocked: 'info', paused: '', queued: '', cancelled: '',
};

export function StateChip({ state }: { state: JobState }) {
  const tone = TONE[state] ?? '';
  return (
    <span className={`chip ${tone}`}>
      {tone === 'run' && <span className="dot busy" />}
      {STATE_LABEL[state]}
    </span>
  );
}

export function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal stack" role="dialog" aria-label={title}>
        <div className="row">
          <h2 className="grow">{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function timeAgo(ts?: number): string {
  if (!ts) return '';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(ts).toLocaleDateString();
}

export function dur(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function readFileText(f: File): Promise<string> {
  return f.text();
}
