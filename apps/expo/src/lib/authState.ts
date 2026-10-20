/**
 * Authentication is not binary during startup. `restoring` is deliberately NOT
 * guest: Firebase is still reading IndexedDB / AsyncStorage and may restore an
 * existing account. Rendering Login / Signup in that window is the flicker this
 * state model prevents.
 */
import type { User } from 'firebase/auth';

export type AuthStatus = 'restoring' | 'authenticated' | 'guest' | 'error';

export interface AuthSnapshot {
  status: AuthStatus;
  user: User | null;
  error: Error | null;
}

export interface AuthFlags {
  loading: boolean;
  ready: boolean;
  signedIn: boolean;
  isGuest: boolean;
  failed: boolean;
}

export function authFlags(snapshot: Pick<AuthSnapshot, 'status' | 'user'>): AuthFlags {
  return {
    loading: snapshot.status === 'restoring',
    ready: snapshot.status === 'authenticated' || snapshot.status === 'guest',
    signedIn: snapshot.status === 'authenticated' && !!snapshot.user,
    isGuest: snapshot.status === 'guest',
    failed: snapshot.status === 'error',
  };
}

/** Identity controls have independent readiness: cached public identity may paint
 * an avatar, but it must never imply that fresh wallet/profile data is ready. */
export function accountShellFlags(status: AuthStatus, hasIdentity: boolean, hasFreshProfile: boolean) {
  const signedIn = status === 'authenticated';
  return {
    avatarLoading: signedIn && !hasIdentity,
    balanceLoading: signedIn && !hasFreshProfile,
    showGuestUi: status === 'guest',
  };
}

/** Synchronous UID boundary for any cached account value. React effects clear
 * old state only after a render; this prevents account A from painting for B. */
export function cachedValueForUid<T extends { uid: string }>(uid: string | null | undefined, cached: T | null): T | null {
  return !!uid && cached?.uid === uid ? cached : null;
}