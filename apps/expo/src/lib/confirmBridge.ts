/**
 * Lets non-React code open the app's confirmation dialog.
 *
 * Same shape as `toastBridge`, and for the same reason: `Alert.alert` is a plain
 * function call from anywhere — event handlers, services, `catch` blocks — so the
 * web replacement for it cannot be a hook. `ConfirmHost` registers itself here on
 * mount and owns the actual dialog.
 */

export interface ConfirmRequest {
  title: string;
  message?: string;
  confirmLabel: string;
  cancelLabel: string;
  destructive?: boolean;
  /** Runs when the user confirms. */
  onConfirm?: () => void;
  /**
   * Runs when the user dismisses.
   *
   * Not optional in spirit: an `Alert.alert` cancel button often has real work to
   * do (resuming a paused story, clearing a flag), and dropping it would leave the
   * screen in the state it was put into for the dialog.
   */
  onCancel?: () => void;
}

type Handler = (req: ConfirmRequest) => void;

let handler: Handler | null = null;

export function setConfirmHandler(fn: Handler | null) {
  handler = fn;
}

/**
 * Show the dialog. Returns false when no host is mounted, so the caller can fall
 * back rather than silently swallowing a decision the user needs to make.
 */
export function requestConfirm(req: ConfirmRequest): boolean {
  if (!handler) return false;
  handler(req);
  return true;
}
