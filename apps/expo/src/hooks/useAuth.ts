import { useSyncExternalStore } from 'react';
import { authFlags } from '@/src/lib/authState';
import {
  continueAuthSessionAsGuest,
  getAuthSessionSnapshot,
  retryAuthSession,
  subscribeAuthSession,
} from '@/src/services/authSession';

/**
 * Shared, synchronous session snapshot. Every caller sees the SAME state; no
 * per-component Firebase listeners and no transient null interpreted as guest.
 */
export const useAuth = () => {
  const snapshot = useSyncExternalStore(subscribeAuthSession, getAuthSessionSnapshot, getAuthSessionSnapshot);
  return {
    ...snapshot,
    ...authFlags(snapshot),
    retry: retryAuthSession,
    continueAsGuest: continueAuthSessionAsGuest,
  };
};
