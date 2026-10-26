import { useEffect, useMemo, useState } from 'react';
import { Platform } from 'react-native';
import { onIdTokenChanged } from 'firebase/auth';
import { auth } from '@/src/services/firebase/initFirebase';
import { useAppConfig, currentAppVersion } from '@/src/services/appSettings';
import { resolveControl, serverNow, type ClientPlatform, type ControlState } from '@/src/lib/appControl';
import { useControlChoices } from '@/src/lib/controlStore';

const STAFF_ROLES = new Set(['superadmin', 'admin', 'moderator']);
const platform: ClientPlatform = Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'web';

/** Signed-in user and whether their token carries a staff role claim. */
export function useViewer(): { signedIn: boolean; isStaff: boolean; uid: string | null } {
  const [v, setV] = useState<{ signedIn: boolean; isStaff: boolean; uid: string | null }>({
    signedIn: !!auth.currentUser,
    isStaff: false,
    uid: auth.currentUser?.uid ?? null,
  });
  useEffect(
    () =>
      onIdTokenChanged(auth, async (user) => {
        if (!user) return setV({ signedIn: false, isStaff: false, uid: null });
        try {
          const t = await user.getIdTokenResult();
          setV({ signedIn: true, isStaff: STAFF_ROLES.has(String(t.claims.role || '')), uid: user.uid });
        } catch {
          setV({ signedIn: true, isStaff: false, uid: user.uid });
        }
      }),
    [],
  );
  return v;
}

/**
 * The resolved App Control state for this device, re-evaluated at the exact
 * moment a schedule starts or ends (no fetch needed for that).
 */
export function useAppControl(): { control: ControlState; config: any; loading: boolean } {
  const { config, loading } = useAppConfig();
  const choices = useControlChoices();
  const viewer = useViewer();
  const [tick, setTick] = useState(0);

  const control = useMemo(
    () =>
      resolveControl({
        config,
        nowMs: serverNow(config),
        platform,
        appVersion: currentAppVersion(),
        isStaff: viewer.isStaff,
        signedIn: viewer.signedIn,
        staffBypass: choices.staffBypass,
        snoozedUpdateFor: choices.snoozedUpdateFor,
        dismissedAnnouncementId: choices.dismissedAnnouncementId,
      }),
    // `tick` re-evaluates at schedule boundaries.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [config, viewer.isStaff, viewer.signedIn, choices, tick],
  );

  useEffect(() => {
    if (!control.nextChangeAt) return;
    const wait = Math.max(250, Math.min(control.nextChangeAt - serverNow(config) + 250, 2_147_000_000));
    const t = setTimeout(() => setTick((n) => n + 1), wait);
    return () => clearTimeout(t);
  }, [control.nextChangeAt, config]);

  return { control, config, loading };
}

export { platform as appPlatform };
