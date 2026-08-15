type ToastType = 'success' | 'error' | 'info';
type ToastHandler = (message: string, type?: ToastType) => void;

// Lets non-React code (e.g. the React Query cache error handlers) surface a
// toast without a hook. ToastProvider registers its addToast here on mount.
let handler: ToastHandler | null = null;

export function setToastHandler(fn: ToastHandler | null) {
  handler = fn;
}

export function emitToast(message: string, type: ToastType = 'info') {
  handler?.(message, type);
}
