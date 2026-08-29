import { useEffect } from 'react';
import { useGlobalSearchParams, useRouter, useSegments } from 'expo-router';
import { actionLinkRedirect } from '@/src/services/auth/actionLink';

/**
 * Take over the screen when a Firebase email action link lands anywhere in the
 * app, and route it to the handler.
 *
 * This is the client-side half of the same rule the Cloudflare worker applies.
 * The worker catches every link that arrives as a fresh HTTP navigation, which is
 * the normal case on the web; this catches the two it cannot see:
 *
 *   - a NATIVE deep link, where no request reaches the worker at all;
 *   - any in-app navigation that already carries the params.
 *
 * Both halves match on the PAYLOAD (`oobCode` + `mode`), not on a path. Keying on
 * Firebase's default `/__/auth/action` path was the first attempt and it did not
 * work: the console's action URL can be any url on the domain, and Firebase
 * appends its query to whatever is configured there, so the path is whatever an
 * operator last typed into a form.
 *
 * Mounted in the root layout, above the auth gate. It cannot fight that gate: a
 * link landing on `/` produces no segments (the gate only acts when
 * `segments.length > 0`) and one landing under `/auth/...` is already inside the
 * gate's exempt group.
 */
export function useFirebaseActionLink(): void {
  const params = useGlobalSearchParams<{ mode?: string; oobCode?: string }>();
  // `useSegments` is typed as a fixed-length tuple from the generated route map,
  // so indexing past the first element is a type error. The runtime value is a
  // plain array of the current path's segments, which is what is needed here.
  const segments = useSegments() as unknown as string[];
  const router = useRouter();

  const mode = typeof params?.mode === 'string' ? params.mode : undefined;
  const oobCode = typeof params?.oobCode === 'string' ? params.oobCode : undefined;

  useEffect(() => {
    const alreadyOnHandler = segments[0] === 'auth' && segments[1] === 'action';
    const target = actionLinkRedirect({ mode, oobCode }, alreadyOnHandler);
    if (!target) return;
    // `replace`, not `push`: the link's url holds a single-use credential, and it
    // must not be left in the history for a back gesture to return to.
    router.replace({
      pathname: '/auth/action',
      params: { mode: target.mode, oobCode: target.oobCode },
    });
  }, [mode, oobCode, segments, router]);
}
