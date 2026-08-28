import React, { useCallback, useRef, useState } from 'react';
import { View, Text, Modal, Pressable, StyleSheet, ActivityIndicator, Platform } from 'react-native';
import { useThemeColor } from '@/hooks/use-theme-color';

/**
 * Cross-platform confirmation dialog.
 *
 * ---------------------------------------------------------------------------
 * Why this exists
 * ---------------------------------------------------------------------------
 * `Alert.alert` with more than one button is a NO-OP on react-native-web. Not a
 * degraded dialog — nothing happens at all. Every multi-button confirmation in
 * this app was therefore silently dead on the web build: the user taps
 * "Delete comment", "Block user", "Report", and the app does nothing, with no
 * error and no feedback. Worse, the destructive action never runs, so it reads as
 * "the button is broken" rather than "the confirmation was cancelled".
 *
 * The workaround that had grown up was `window.confirm` on web, which does work
 * but is a browser chrome dialog: unstyleable, says the site's hostname, cannot
 * show a loading state while the action runs, and blocks the JS thread.
 *
 * So this is one dialog that behaves identically on both platforms, is themed,
 * and can stay open with a spinner while the confirmed action completes — which
 * matters for logout and account deletion, where the work is a network round trip
 * and the user must not be able to press twice.
 *
 * ---------------------------------------------------------------------------
 * Usage
 * ---------------------------------------------------------------------------
 *   const { confirm, dialog } = useConfirm();
 *
 *   const onLogout = async () => {
 *     const ok = await confirm({
 *       title: 'Log out?',
 *       message: 'You will need to sign in again to enter contests.',
 *       confirmLabel: 'Log out',
 *       destructive: true,
 *     });
 *     if (ok) await performLogout();
 *   };
 *
 *   // ...and render {dialog} once in the tree.
 */

export interface ConfirmOptions {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Red confirm button, for irreversible actions. */
  destructive?: boolean;
  /**
   * Run the action while the dialog stays open with a spinner.
   *
   * Without this the dialog closes first and the caller shows its own loading
   * state — fine for cheap actions, wrong for a slow one, because the screen
   * looks idle and the user taps again.
   */
  onConfirm?: () => Promise<void>;
}

type Request = ConfirmOptions & { resolve: (ok: boolean) => void };

export function useConfirm() {
  const [req, setReq] = useState<Request | null>(null);
  const [busy, setBusy] = useState(false);
  // Guards against a second tap resolving the same promise twice.
  const settled = useRef(false);

  const confirm = useCallback((opts: ConfirmOptions): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      settled.current = false;
      setReq({ ...opts, resolve });
    });
  }, []);

  const close = useCallback((ok: boolean) => {
    if (settled.current) return;
    settled.current = true;
    setReq((current) => {
      current?.resolve(ok);
      return null;
    });
    setBusy(false);
  }, []);

  const handleConfirm = useCallback(async () => {
    if (!req || busy) return;
    if (!req.onConfirm) {
      close(true);
      return;
    }
    setBusy(true);
    try {
      await req.onConfirm();
      close(true);
    } catch {
      // The caller is responsible for surfacing the failure (a toast, usually).
      // Closing anyway avoids trapping the user in a dialog they cannot dismiss.
      close(false);
    }
  }, [req, busy, close]);

  const dialog = req ? (
    <ConfirmDialog
      {...req}
      busy={busy}
      onCancel={() => (busy ? undefined : close(false))}
      onConfirm={handleConfirm}
    />
  ) : null;

  return { confirm, dialog };
}

/**
 * `onConfirm` is omitted and re-declared: on the options it is the caller's async
 * action, here it is the presentational press handler the hook supplies.
 */
interface Props extends Omit<ConfirmOptions, 'onConfirm'> {
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export const ConfirmDialog: React.FC<Props> = ({
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive,
  busy,
  onCancel,
  onConfirm,
}) => {
  const card = useThemeColor({}, 'background');
  const textColor = useThemeColor({}, 'text');

  return (
    <Modal
      visible
      transparent
      animationType="fade"
      // Android hardware back / web Escape must behave like Cancel, not like a
      // silent dismissal that leaves the awaiting promise unresolved.
      onRequestClose={onCancel}
    >
      <Pressable
        style={styles.backdrop}
        // Tapping the backdrop cancels, except while the action is running — a
        // half-finished logout or deletion must not be abandoned mid-flight.
        onPress={onCancel}
        accessibilityLabel={busy ? undefined : 'Dismiss'}
      >
        {/* Swallow presses on the card so they don't reach the backdrop. */}
        <Pressable
          style={[styles.card, { backgroundColor: card }]}
          onPress={() => {}}
          accessibilityViewIsModal
          accessibilityRole={Platform.OS === 'web' ? undefined : 'alert'}
        >
          <Text style={[styles.title, { color: textColor }]}>{title}</Text>
          {!!message && <Text style={styles.message}>{message}</Text>}

          <View style={styles.actions}>
            <Pressable
              onPress={onCancel}
              disabled={busy}
              style={[styles.btn, styles.cancelBtn, busy && styles.btnDisabled]}
              accessibilityRole="button"
              accessibilityLabel={cancelLabel}
            >
              <Text style={[styles.cancelText, { color: textColor }]}>{cancelLabel}</Text>
            </Pressable>

            <Pressable
              onPress={onConfirm}
              disabled={busy}
              style={[
                styles.btn,
                destructive ? styles.destructiveBtn : styles.confirmBtn,
                busy && styles.btnDisabled,
              ]}
              accessibilityRole="button"
              accessibilityLabel={confirmLabel}
              accessibilityState={{ busy }}
            >
              {busy ? (
                <ActivityIndicator color="#fff" size="small" />
              ) : (
                <Text style={styles.confirmText}>{confirmLabel}</Text>
              )}
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
};

export default ConfirmDialog;

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  card: {
    width: '100%',
    maxWidth: 400,
    borderRadius: 20,
    paddingHorizontal: 22,
    paddingTop: 22,
    paddingBottom: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.18,
    shadowRadius: 20,
    elevation: 8,
  },
  title: { fontSize: 18, fontFamily: 'Urbanist-Bold', marginBottom: 8 },
  message: { fontSize: 14, lineHeight: 20, color: '#8A8A8E', marginBottom: 20 },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10 },
  btn: {
    minWidth: 104,
    height: 46,
    borderRadius: 23,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 18,
  },
  btnDisabled: { opacity: 0.6 },
  cancelBtn: { backgroundColor: 'rgba(142,142,147,0.16)' },
  cancelText: { fontSize: 15, fontFamily: 'Urbanist-Bold' },
  confirmBtn: { backgroundColor: '#FF4D67' },
  destructiveBtn: { backgroundColor: '#E53935' },
  confirmText: { color: '#fff', fontSize: 15, fontFamily: 'Urbanist-Bold' },
});
