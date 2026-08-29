/**
 * The web `Alert` replacement.
 *
 * `react-native-web`'s Alert is, verbatim, `class Alert { static alert() {} }` —
 * an empty function. Every one of this app's ~70 `Alert.alert` calls therefore did
 * nothing on web: no error messages, no success messages, and no confirmations.
 * A failed withdrawal was indistinguishable from a successful one.
 *
 * These tests pin the mapping, because each way of getting it wrong is silent:
 *
 *  - An informational alert must become a toast. If it became a dialog, ordinary
 *    errors would start blocking the UI behind an OK button.
 *  - A decision must become a dialog. If it became a toast, the destructive
 *    handler would either never run or — far worse — run unconfirmed.
 *  - BOTH branches of a two-button alert must be wired. The cancel button often
 *    has real work to do (resuming a paused story), and dropping it leaves the
 *    screen stuck in the state it was put into for the dialog.
 *  - Native must be untouched, so the platform dialog is preserved.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const toasts: { message: string; type?: string }[] = [];
const confirms: any[] = [];
let confirmHostMounted = true;

vi.mock('@/src/lib/toastBridge', () => ({
  emitToast: (message: string, type?: string) => toasts.push({ message, type }),
}));

vi.mock('@/src/lib/confirmBridge', () => ({
  requestConfirm: (req: any) => {
    confirms.push(req);
    return confirmHostMounted;
  },
}));

const rnAlert = vi.fn();
let platformOS = 'web';
vi.mock('react-native', () => ({
  get Platform() {
    return { OS: platformOS };
  },
  Alert: { alert: (...args: any[]) => rnAlert(...args) },
}));

const { Alert } = await import('@/src/lib/appAlert');

beforeEach(() => {
  toasts.length = 0;
  confirms.length = 0;
  rnAlert.mockClear();
  platformOS = 'web';
  confirmHostMounted = true;
});
afterEach(() => vi.unstubAllGlobals());

describe('informational alerts become toasts', () => {
  it('shows a message-only alert', () => {
    Alert.alert('Upload failed', 'Please try again.');
    expect(toasts).toEqual([{ message: 'Upload failed — Please try again.', type: 'error' }]);
    // Crucially NOT a dialog: a plain error must not block the screen.
    expect(confirms).toHaveLength(0);
  });

  it('shows a title-only alert', () => {
    Alert.alert('Copied');
    expect(toasts[0].message).toBe('Copied');
  });

  it('infers tone from the wording', () => {
    Alert.alert('Insufficient Coins');
    Alert.alert('Request submitted');
    Alert.alert('Come back tomorrow');
    expect(toasts.map((t) => t.type)).toEqual(['error', 'success', 'info']);
  });

  it('runs a single button’s handler, since dismissing is all it would have done', () => {
    const onPress = vi.fn();
    Alert.alert('Session expired', 'Sign in again.', [{ text: 'OK', onPress }]);
    expect(toasts).toHaveLength(1);
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});

describe('decisions become a dialog', () => {
  it('maps cancel + destructive action', () => {
    const onDelete = vi.fn();
    const onCancel = vi.fn();
    Alert.alert('Delete Story', 'Are you sure?', [
      { text: 'Cancel', style: 'cancel', onPress: onCancel },
      { text: 'Delete', style: 'destructive', onPress: onDelete },
    ]);

    expect(toasts).toHaveLength(0);
    expect(confirms).toHaveLength(1);
    const req = confirms[0];
    expect(req).toMatchObject({
      title: 'Delete Story',
      message: 'Are you sure?',
      confirmLabel: 'Delete',
      cancelLabel: 'Cancel',
      destructive: true,
    });

    // Both branches must be wired, not just the happy one.
    req.onConfirm();
    expect(onDelete).toHaveBeenCalledTimes(1);
    req.onCancel();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('does not run the action until the user confirms', () => {
    const onDelete = vi.fn();
    Alert.alert('Delete Chat', undefined, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: onDelete },
    ]);
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('treats the default-styled button as cancel when none is marked cancel', () => {
    // The signup "Resume your signup?" alert: [Start over (destructive), Resume
    // (default)]. Taking the FIRST button as the action would make wiping the
    // half-finished signup the dialog's primary button.
    const startOver = vi.fn();
    const resume = vi.fn();
    Alert.alert('Resume your signup?', 'Continue where you left off?', [
      { text: 'Start over', style: 'destructive', onPress: startOver },
      { text: 'Resume', style: 'default', onPress: resume },
    ]);

    const req = confirms[0];
    expect(req.cancelLabel).toBe('Resume');
    expect(req.confirmLabel).toBe('Start over');
    expect(req.destructive).toBe(true);
  });

  it('marks a non-destructive action as such', () => {
    Alert.alert('Report comment?', 'Our team will review it.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Report' },
    ]);
    expect(confirms[0].destructive).toBe(false);
  });

  it('warns rather than silently dropping a third option', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    Alert.alert('Pick one', undefined, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'A' },
      { text: 'B' },
    ]);
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0][0])).toContain('Dropped');
    warn.mockRestore();
  });

  it('retries once before falling back, for the host-not-yet-mounted race', async () => {
    // ConfirmHost registers in an effect and React flushes effects in tree order,
    // so a screen raising a confirmation from its OWN mount effect runs first.
    // This happened in production: the signup resume prompt fell through to the
    // browser dialog. The retry must catch a host that appears a tick later.
    confirmHostMounted = false;
    const onDelete = vi.fn();
    Alert.alert('Delete Story', 'Sure?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: onDelete },
    ]);
    expect(confirms).toHaveLength(1); // first attempt, rejected

    confirmHostMounted = true; // host mounts
    await new Promise((r) => setTimeout(r, 0));

    expect(confirms).toHaveLength(2); // retried, accepted
    confirms[1].onConfirm();
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it('falls back to the browser dialog when no host ever appears', async () => {
    confirmHostMounted = false;
    const onDelete = vi.fn();
    vi.stubGlobal('window', { confirm: () => true });

    Alert.alert('Delete Story', 'Sure?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: onDelete },
    ]);
    await new Promise((r) => setTimeout(r, 0));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it('honours a declined browser fallback', async () => {
    confirmHostMounted = false;
    const onDelete = vi.fn();
    const onCancel = vi.fn();
    vi.stubGlobal('window', { confirm: () => false });

    Alert.alert('Delete Story', 'Sure?', [
      { text: 'Cancel', style: 'cancel', onPress: onCancel },
      { text: 'Delete', style: 'destructive', onPress: onDelete },
    ]);
    await new Promise((r) => setTimeout(r, 0));
    expect(onDelete).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe('native is untouched', () => {
  it('delegates to the platform Alert', () => {
    platformOS = 'ios';
    const buttons = [{ text: 'Cancel', style: 'cancel' as const }, { text: 'Delete' }];
    Alert.alert('Delete Story', 'Sure?', buttons);

    expect(rnAlert).toHaveBeenCalledWith('Delete Story', 'Sure?', buttons, undefined);
    // No web substitutes on native.
    expect(toasts).toHaveLength(0);
    expect(confirms).toHaveLength(0);
  });
});
