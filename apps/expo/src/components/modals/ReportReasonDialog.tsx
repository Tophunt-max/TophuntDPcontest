import React, { useCallback, useRef, useState } from 'react';
import {
  View,
  Text,
  Modal,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  Platform,
  TextInput,
  ScrollView,
} from 'react-native';
import { useThemeColor } from '@/hooks/use-theme-color';
import { Ionicons } from '@/src/lib/icons';

/**
 * Report with a reason, in the same card style as `ConfirmDialog` (Logout).
 *
 * Every report used to send one fixed string ("Reported from profile", "spam /
 * QR / fake entry", "Inappropriate comment"), so moderators could not tell a
 * scam from harassment without opening each one. The server already stores a
 * free-text `reason` (trimmed to 300 chars), so this only changes what is sent.
 *
 *   const { askReason, dialog } = useReportReason();
 *   const reason = await askReason({
 *     title: 'Report @bubun?',
 *     reasons: USER_REPORT_REASONS,
 *     onSubmit: (reason) => reportUserService(uid, reason),
 *   });
 *   // reason: the string that was sent, or null if cancelled / failed.
 *   // ...and render {dialog} once.
 *
 * Like `ConfirmDialog`, the request runs while the dialog stays open with a
 * spinner, so it cannot be sent twice. If `onSubmit` throws, the dialog closes
 * and resolves null; the caller shows the error.
 */

export type ReportReason = { key: string; label: string; hint?: string };

/** "Other" is appended to every list and asks for a short description. */
export const OTHER_REASON: ReportReason = { key: 'other', label: 'Something else', hint: 'Tell us what is wrong' };

export const USER_REPORT_REASONS: ReportReason[] = [
  { key: 'scam', label: 'Scam or fraud', hint: 'QR codes, payment requests, fake prizes' },
  { key: 'spam', label: 'Spam' },
  { key: 'fake', label: 'Fake account / impersonation', hint: 'Pretending to be someone else' },
  { key: 'harassment', label: 'Bullying or harassment' },
  { key: 'nudity', label: 'Nudity or sexual content' },
  { key: 'hate', label: 'Hate speech or violence' },
  { key: 'underage', label: 'May be under 13' },
];

export const BATTLE_REPORT_REASONS: ReportReason[] = [
  { key: 'scam', label: 'QR code / payment scam' },
  { key: 'not_theirs', label: "Not their photo or video", hint: 'Stolen, celebrity or AI image' },
  { key: 'spam', label: 'Spam or fake entry' },
  { key: 'nudity', label: 'Nudity or sexual content' },
  { key: 'hate', label: 'Hate speech or violence' },
  { key: 'cheating', label: 'Vote cheating', hint: 'Fake votes, vote buying' },
];

export const COMMENT_REPORT_REASONS: ReportReason[] = [
  { key: 'spam', label: 'Spam or scam link' },
  { key: 'harassment', label: 'Bullying or harassment' },
  { key: 'hate', label: 'Hate speech' },
  { key: 'nudity', label: 'Sexual content' },
  { key: 'false', label: 'False information' },
];

const MAX_DETAIL = 200;

/** The reason string sent to the server, e.g. "scam: Scam or fraud" or "other: <text>". */
export function reportReasonText(reason: ReportReason, detail?: string): string {
  const extra = (detail || '').trim().slice(0, MAX_DETAIL);
  if (reason.key === OTHER_REASON.key) return `other: ${extra}`;
  return extra ? `${reason.key}: ${reason.label} — ${extra}` : `${reason.key}: ${reason.label}`;
}

type AskOptions = {
  title: string;
  message?: string;
  reasons: ReportReason[];
  submitLabel?: string;
  onSubmit: (reason: string) => Promise<unknown>;
};

type Request = AskOptions & { resolve: (reason: string | null) => void };

export function useReportReason() {
  const [req, setReq] = useState<Request | null>(null);
  const [busy, setBusy] = useState(false);
  const settled = useRef(false);

  const askReason = useCallback((opts: AskOptions): Promise<string | null> => {
    return new Promise<string | null>((resolve) => {
      settled.current = false;
      setReq({ ...opts, resolve });
    });
  }, []);

  const close = useCallback((value: string | null) => {
    if (settled.current) return;
    settled.current = true;
    setReq((current) => {
      current?.resolve(value);
      return null;
    });
    setBusy(false);
  }, []);

  const submit = useCallback(
    async (reason: string) => {
      if (!req || busy) return;
      setBusy(true);
      try {
        await req.onSubmit(reason);
        close(reason);
      } catch {
        // The caller surfaces the failure; never trap the user in the dialog.
        close(null);
      }
    },
    [req, busy, close],
  );

  const dialog = req ? (
    <ReportReasonDialog
      title={req.title}
      message={req.message}
      reasons={req.reasons}
      submitLabel={req.submitLabel}
      busy={busy}
      onCancel={() => (busy ? undefined : close(null))}
      onSubmit={submit}
    />
  ) : null;

  return { askReason, dialog };
}

export const ReportReasonDialog: React.FC<{
  title: string;
  message?: string;
  reasons: ReportReason[];
  submitLabel?: string;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (reason: string) => void;
}> = ({ title, message, reasons, submitLabel = 'Report', busy, onCancel, onSubmit }) => {
  const card = useThemeColor({}, 'background');
  const textColor = useThemeColor({}, 'text');
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState('');

  const all = [...reasons, OTHER_REASON];
  const picked = all.find((r) => r.key === selected) || null;
  const needsDetail = picked?.key === OTHER_REASON.key;
  const canSubmit = !!picked && (!needsDetail || detail.trim().length >= 3) && !busy;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onCancel}>
      <Pressable style={styles.backdrop} onPress={onCancel} accessibilityLabel={busy ? undefined : 'Dismiss'}>
        <Pressable
          style={[styles.card, { backgroundColor: card }]}
          onPress={() => {}}
          accessibilityViewIsModal
          accessibilityRole={Platform.OS === 'web' ? undefined : 'alert'}
        >
          <Text style={[styles.title, { color: textColor }]}>{title}</Text>
          <Text style={styles.message}>
            {message || 'Why are you reporting this? Reporting is anonymous: they will not know it was you.'}
          </Text>

          <ScrollView style={styles.list} keyboardShouldPersistTaps="handled">
            {all.map((r) => {
              const on = r.key === selected;
              return (
                <Pressable
                  key={r.key}
                  onPress={() => setSelected(r.key)}
                  disabled={busy}
                  style={[styles.option, on && styles.optionOn]}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: on, disabled: busy }}
                  accessibilityLabel={r.label}
                  accessibilityHint={r.hint}
                >
                  <Ionicons
                    name={on ? 'radio-button-on' : 'radio-button-off'}
                    size={20}
                    color={on ? '#FF4D67' : '#8A8A8E'}
                  />
                  <View style={styles.optionText}>
                    <Text style={[styles.optionLabel, { color: textColor }]}>{r.label}</Text>
                    {!!r.hint && <Text style={styles.optionHint}>{r.hint}</Text>}
                  </View>
                </Pressable>
              );
            })}
            {needsDetail && (
              <TextInput
                value={detail}
                onChangeText={setDetail}
                editable={!busy}
                placeholder="Describe the problem"
                placeholderTextColor="#8A8A8E"
                maxLength={MAX_DETAIL}
                multiline
                autoFocus
                style={[styles.detail, { color: textColor }]}
                accessibilityLabel="Describe the problem"
              />
            )}
          </ScrollView>

          <View style={styles.actions}>
            <Pressable
              onPress={onCancel}
              disabled={busy}
              style={[styles.btn, styles.cancelBtn, busy && styles.btnDisabled]}
              accessibilityRole="button"
              accessibilityLabel="Cancel"
            >
              <Text style={[styles.cancelText, { color: textColor }]}>Cancel</Text>
            </Pressable>
            <Pressable
              onPress={() => picked && onSubmit(reportReasonText(picked, detail))}
              disabled={!canSubmit}
              style={[styles.btn, styles.destructiveBtn, !canSubmit && styles.btnDisabled]}
              accessibilityRole="button"
              accessibilityLabel={submitLabel}
              accessibilityState={{ busy, disabled: !canSubmit }}
            >
              {busy ? <ActivityIndicator color="#fff" size="small" /> : <Text style={styles.confirmText}>{submitLabel}</Text>}
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
};

export default ReportReasonDialog;

// Card, title, message and button styles match ConfirmDialog exactly.
const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center', padding: 24 },
  card: {
    width: '100%',
    maxWidth: 400,
    maxHeight: '88%',
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
  message: { fontSize: 14, lineHeight: 20, color: '#8A8A8E', marginBottom: 12 },
  list: { flexGrow: 0, marginBottom: 16 },
  option: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, paddingHorizontal: 10, borderRadius: 12 },
  optionOn: { backgroundColor: 'rgba(255,77,103,0.10)' },
  optionText: { flex: 1 },
  optionLabel: { fontSize: 15, fontFamily: 'Urbanist-SemiBold' },
  optionHint: { fontSize: 12, color: '#8A8A8E', marginTop: 1 },
  detail: {
    minHeight: 64,
    marginTop: 8,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(142,142,147,0.35)',
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    textAlignVertical: 'top',
  },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10 },
  btn: { minWidth: 104, height: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 18 },
  btnDisabled: { opacity: 0.5 },
  cancelBtn: { backgroundColor: 'rgba(142,142,147,0.16)' },
  cancelText: { fontSize: 15, fontFamily: 'Urbanist-Bold' },
  destructiveBtn: { backgroundColor: '#E53935' },
  confirmText: { color: '#fff', fontSize: 15, fontFamily: 'Urbanist-Bold' },
});
