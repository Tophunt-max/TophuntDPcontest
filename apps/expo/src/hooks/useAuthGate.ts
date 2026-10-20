import { useCallback } from 'react';
import { useGlobalSearchParams, usePathname, useRouter, useSegments } from 'expo-router';
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
  const { user, status, ready, signedIn, isGuest } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const params = useGlobalSearchParams();
  const segments = useSegments();
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
      if (status === 'authenticated' && user) return true;
      // Root normally withholds the route tree while restoring/error. Fail closed
      // without showing a false Login prompt if an action races that boundary.
      if (status !== 'guest') return false;
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
    [status, user, router, pathname, params, segments],
  );

  return { requireAuth, status, authReady: ready, isGuest, signedIn };
}
