type ToastType = 'success' | 'error' | 'info';

export interface ToastEmitOptions {
  /** Named custom icon variant (see ToastIcon in ToastProvider). */
  icon?: string;
}

type ToastHandler = (message: string, type?: ToastType, opts?: ToastEmitOptions) => void;

// Lets non-React code (e.g. the React Query cache error handlers, connectivity
// watcher) surface a toast without a hook. ToastProvider registers its addToast
// here on mount.
let handler: ToastHandler | null = null;

export function setToastHandler(fn: ToastHandler | null) {
  handler = fn;
}

export function emitToast(message: string, type: ToastType = 'info', opts?: ToastEmitOptions) {
  handler?.(message, type, opts);
}
