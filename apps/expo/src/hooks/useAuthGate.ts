import { useCallback } from 'react';
import { useGlobalSearchParams, usePathname, useRouter, useSegments } from 'expo-router';
import { auth } from '@/src/services/firebase/initFirebase';
import { useAuth } from '@/src/hooks/useAuth';
import { Alert } from '@/src/lib/appAlert';
import { authPromptCopy, loginHref, pathWithQuery, type GatedAction } from '@/src/lib/authGate';

/**
 * Login at the moment of action.
 *
 *   const { requireAuth, isGuest } = useAuthGate();
 *   onPress={() => requireAuth('like') && like()}
 *
 * Signed in → returns true and the caller proceeds. Guest → shows a prompt that
 * names the action (Not now / Sign in) and returns false. "Sign in" opens login
 * with a sanitised return path to the current screen (or `returnTo`). The action
 * is never replayed automatically after sign-in.
 *
 * This is UX only. Every protected action is enforced by the Worker regardless.
 */
export function useAuthGate() {
  const { user } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const params = useGlobalSearchParams();
  const segments = useSegments();
  // `auth.currentUser` covers the first render before the hook's listener fires.
  const signedIn = !!(user ?? auth.currentUser);

  const requireAuth = useCallback(
    (
      action: GatedAction,
      opts: {
        /** Return path after sign-in; defaults to the current screen. */
        returnTo?: string;
        /** Close any sheet/modal (portals render above navigation) before leaving. */
        beforeNavigate?: () => void;
      } = {},
    ): boolean => {
      if (user ?? auth.currentUser) return true;
      const { title, message } = authPromptCopy(action);
      const back = opts.returnTo ?? pathWithQuery(pathname, params as Record<string, unknown>, segments as string[]);
      Alert.alert(title, message, [
        { text: 'Not now', style: 'cancel' },
        {
          text: 'Sign in',
          onPress: () => {
            opts.beforeNavigate?.();
            router.push(loginHref(back) as any);
          },
        },
      ]);
      return false;
    },
    [user, router, pathname, params, segments],
  );

  return { requireAuth, isGuest: !signedIn, signedIn };
}
