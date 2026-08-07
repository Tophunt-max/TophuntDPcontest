// ============================================================================
// Popup notifications — drop-in replacement for sonner's `toast`.
// ============================================================================
//
// Every admin page previously imported `{ toast } from 'sonner'`, which showed
// small corner toasts. This module keeps the EXACT same API
// (toast.success / .error / .warning / .info, and the shadcn-style object form
// toast({ title, description, variant })) but renders a branded CENTERED POPUP
// over a dimmed backdrop with a scale/fade entrance animation.
//
// Usage stays identical — just import from '@/lib/toast' instead of 'sonner':
//   import { toast } from '@/lib/toast';
//   toast.success('Saved!');
//   toast.error('Something went wrong', { description: '...' });
//
// Mount <PopupToaster /> once at the app root (see App.tsx).

import { useEffect, useState } from 'react';
import { CheckCircle2, XCircle, AlertTriangle, Info, X } from 'lucide-react';
import { cn } from '@/lib/utils';

export type ToastType = 'success' | 'error' | 'warning' | 'info';

export interface ToastOptions {
  description?: string;
  duration?: number;
}

interface ToastItem {
  id: number;
  type: ToastType;
  message: string;
  description?: string;
  duration: number;
}

// ─── Tiny external store so toast.*() works from anywhere (even non-React
// code like pendingAlerts.tsx), mirroring sonner's imperative API. ──────────
let items: ToastItem[] = [];
const listeners = new Set<(items: ToastItem[]) => void>();
let counter = 0;

function emit() {
  const snapshot = [...items];
  listeners.forEach((l) => l(snapshot));
}

function dismiss(id: number) {
  items = items.filter((i) => i.id !== id);
  emit();
}

function dismissAll() {
  items = [];
  emit();
}

function show(type: ToastType, message: string, opts?: ToastOptions): number {
  const id = ++counter;
  const duration = opts?.duration ?? (type === 'error' ? 5000 : 3500);
  items = [{ id, type, message, description: opts?.description, duration }, ...items].slice(0, 4);
  emit();
  if (duration > 0 && typeof window !== 'undefined') {
    window.setTimeout(() => dismiss(id), duration);
  }
  return id;
}

// shadcn-style object form used by a few pages: toast({ title, description, variant })
interface ObjectToast {
  title?: string;
  description?: string;
  variant?: 'default' | 'destructive';
}

type ToastInput = string | ObjectToast;

function callable(input: ToastInput, opts?: ToastOptions): number {
  if (typeof input === 'string') {
    return show('info', input, opts);
  }
  const type: ToastType = input.variant === 'destructive' ? 'error' : 'success';
  return show(type, input.title ?? input.description ?? '', {
    description: input.title ? input.description : undefined,
  });
}

/** Drop-in replacement for sonner's `toast` (callable + typed methods). */
export const toast = Object.assign(callable, {
  success: (message: string, opts?: ToastOptions) => show('success', message, opts),
  error: (message: string, opts?: ToastOptions) => show('error', message, opts),
  warning: (message: string, opts?: ToastOptions) => show('warning', message, opts),
  info: (message: string, opts?: ToastOptions) => show('info', message, opts),
  dismiss,
});

// ─── Renderer ───────────────────────────────────────────────────────────────
const TYPE_META: Record<
  ToastType,
  { Icon: typeof CheckCircle2; iconColor: string; ring: string; btn: string }
> = {
  success: { Icon: CheckCircle2, iconColor: 'text-emerald-500', ring: 'bg-emerald-500/10', btn: 'bg-emerald-500 hover:bg-emerald-600' },
  error:   { Icon: XCircle,      iconColor: 'text-red-500',     ring: 'bg-red-500/10',     btn: 'bg-red-500 hover:bg-red-600' },
  warning: { Icon: AlertTriangle,iconColor: 'text-amber-500',   ring: 'bg-amber-500/10',   btn: 'bg-amber-500 hover:bg-amber-600' },
  info:    { Icon: Info,         iconColor: 'text-violet-500',  ring: 'bg-violet-500/10',  btn: 'bg-primary hover:bg-primary/90' },
};

/**
 * Single global popup host. Accepts (and ignores) sonner Toaster props like
 * `position` / `richColors` so it can be dropped in without changing App.tsx
 * prop usage.
 */
export function PopupToaster(_props?: Record<string, unknown>) {
  const [list, setList] = useState<ToastItem[]>([]);

  useEffect(() => {
    const l = (next: ToastItem[]) => setList(next);
    listeners.add(l);
    setList([...items]);
    return () => {
      listeners.delete(l);
    };
  }, []);

  if (list.length === 0) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 pointer-events-none">
      <div
        className="absolute inset-0 bg-black/50 pointer-events-auto animate-in fade-in-0 duration-200"
        onClick={dismissAll}
        aria-hidden
      />
      <div className="relative flex flex-col items-center gap-3 pointer-events-none">
        {list.map((t) => {
          const meta = TYPE_META[t.type];
          const Icon = meta.Icon;
          return (
            <div
              key={t.id}
              role="alert"
              className="pointer-events-auto relative w-[min(90vw,26rem)] rounded-2xl border bg-background p-6 shadow-xl flex flex-col items-center text-center animate-in fade-in-0 zoom-in-95 slide-in-from-top-2 duration-200"
            >
              <button
                onClick={() => dismiss(t.id)}
                className="absolute right-3 top-3 text-muted-foreground hover:text-foreground transition-colors"
                aria-label="Dismiss"
              >
                <X className="h-4 w-4" />
              </button>

              <div className={cn('mb-3 flex h-14 w-14 items-center justify-center rounded-full', meta.ring)}>
                <Icon className={cn('h-8 w-8', meta.iconColor)} />
              </div>

              <p className="text-base font-semibold text-foreground break-words">{t.message}</p>
              {t.description ? (
                <p className="mt-1 text-sm text-muted-foreground break-words">{t.description}</p>
              ) : null}

              <button
                onClick={() => dismiss(t.id)}
                className={cn('mt-4 rounded-xl px-6 py-2 text-sm font-medium text-white transition-colors', meta.btn)}
              >
                OK
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
