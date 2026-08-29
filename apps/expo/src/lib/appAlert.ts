import { Alert as RNAlert, Platform } from 'react-native';
import { emitToast } from './toastBridge';
import { requestConfirm } from './confirmBridge';

/**
 * Drop-in replacement for react-native's `Alert`, because on web the real one
 * does nothing at all.
 *
 * ---------------------------------------------------------------------------
 * The bug this fixes
 * ---------------------------------------------------------------------------
 * `react-native-web`'s Alert is, verbatim:
 *
 *     class Alert { static alert() {} }
 *
 * An empty function. Not "multi-button is unsupported" — *nothing* happens, for
 * every call. This app had ~70 `Alert.alert` call sites, so on the web build the
 * user got no feedback whatsoever from any of them: "Upload failed",
 * "Insufficient Coins", "Invalid OTP", "Below minimum", "Account required",
 * "Request submitted", "Bonus Claimed!" — all silently discarded. A failed
 * withdrawal looked identical to a successful one.
 *
 * The confirmations were worse than invisible: "Delete Chat", "Delete Story",
 * "Delete comment?" and the block/mute actions never ran their handler, so the
 * button read as broken rather than as cancelled.
 *
 * ---------------------------------------------------------------------------
 * How the mapping works
 * ---------------------------------------------------------------------------
 * Native is untouched — it delegates straight to `RNAlert`, so the platform look
 * and behaviour are preserved. On web:
 *
 *  - 0 or 1 button (an informational alert) becomes a toast. A single button's
 *    `onPress` is invoked immediately, since the only thing dismissing that
 *    dialog would have done is run it.
 *  - 2+ buttons become the app's ConfirmDialog, because that is a decision and a
 *    toast cannot take one.
 *
 * Keeping the `Alert.alert(title, message, buttons)` signature is deliberate: it
 * means ~70 call sites are fixed by changing an import line, with no behavioural
 * edit at each one to get wrong.
 */

export interface AlertButton {
  text?: string;
  onPress?: (value?: string) => void;
  style?: 'default' | 'cancel' | 'destructive';
}

/** Titles that read as failures / successes, for choosing the toast tone. */
const ERROR_RE = /error|fail|invalid|insufficient|cannot|could not|denied|unavailable|required|too long|oops|wrong/i;
const SUCCESS_RE = /success|submitted|claimed|earned|copied|sent|thanks|deleted|saved|updated/i;

function toneFor(title: string, message?: string): 'success' | 'error' | 'info' {
  const text = `${title} ${message ?? ''}`;
  if (ERROR_RE.test(text)) return 'error';
  if (SUCCESS_RE.test(text)) return 'success';
  return 'info';
}

/**
 * Which button is "cancel" and which is the action.
 *
 * `style: 'cancel'` when present. Otherwise the `default`-styled button is the
 * safe choice and the other is the action — that is the case in the signup
 * "Resume your signup?" alert, where the buttons are [Start over (destructive),
 * Resume (default)] and treating the *first* as the action would make the
 * dangerous option the dialog's primary.
 */
function classify(buttons: AlertButton[]): { cancel: AlertButton; action: AlertButton; extra: AlertButton[] } {
  const cancelIndex = (() => {
    const explicit = buttons.findIndex((b) => b.style === 'cancel');
    if (explicit !== -1) return explicit;
    const dflt = buttons.findIndex((b) => b.style === 'default');
    if (dflt !== -1) return dflt;
    return buttons.length - 1;
  })();
  const cancel = buttons[cancelIndex];
  const rest = buttons.filter((_, i) => i !== cancelIndex);
  return { cancel, action: rest[0], extra: rest.slice(1) };
}

function webAlert(title: string, message?: string, buttons?: AlertButton[]): void {
  const list = buttons ?? [];

  if (list.length <= 1) {
    emitToast([title, message].filter(Boolean).join(' — '), toneFor(title, message));
    list[0]?.onPress?.();
    return;
  }

  const { cancel, action, extra } = classify(list);
  if (extra.length > 0) {
    // No call site does this today. Warn rather than silently dropping choices,
    // so a future three-way alert is noticed instead of quietly losing an option.
    console.warn(
      `[alert] "${title}" has ${list.length} buttons; the web dialog shows two. ` +
        `Dropped: ${extra.map((b) => b.text).join(', ')}`,
    );
  }

  const request = {
    title,
    message,
    confirmLabel: action?.text || 'OK',
    cancelLabel: cancel?.text || 'Cancel',
    destructive: action?.style === 'destructive',
    onConfirm: () => action?.onPress?.(),
    onCancel: () => cancel?.onPress?.(),
  };

  if (requestConfirm(request)) return;

  /**
   * Retry on the next macrotask before giving up.
   *
   * `ConfirmHost` registers itself in an effect, and React flushes effects in
   * tree order — so a screen that raises a confirmation from its own mount
   * effect runs BEFORE the host further down the root layout has registered.
   * That is not hypothetical: the signup "Resume your signup?" prompt fires on
   * mount and lost this race in production, falling through to the browser
   * dialog. Deferring one tick puts us after the effect flush.
   *
   * The host is intentionally not hoisted above the navigator to fix this
   * instead: it renders a Modal, and on web a later sibling wins the stacking
   * order, so moving it earlier risks the dialog appearing *behind* the app.
   */
  setTimeout(() => {
    if (requestConfirm(request)) return;

    // Genuinely no host — a tree that skips the root layout. The browser dialog
    // is ugly, but losing a decision the user has to make is what this module
    // exists to prevent.
    const ok = typeof window !== 'undefined' ? window.confirm(`${title}${message ? `\n\n${message}` : ''}`) : false;
    (ok ? action : cancel)?.onPress?.();
  }, 0);
}

export const Alert = {
  alert(title: string, message?: string, buttons?: AlertButton[], options?: unknown): void {
    if (Platform.OS !== 'web') {
      RNAlert.alert(title, message, buttons as any, options as any);
      return;
    }
    webAlert(title, message, buttons);
  },
};

export default Alert;
