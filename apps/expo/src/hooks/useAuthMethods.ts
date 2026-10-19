import { useEffect, useMemo, useState } from 'react';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useQuery } from '@tanstack/react-query';
import { APP_CONFIG_QUERY_KEY, fetchAppConfig } from '@/src/services/appSettings';
import { newerConfig } from '@/src/lib/appControl';
import { FALLBACK_AUTH_METHODS, resolveClientAuthMethods, type ClientAuthMethods, type ClientPlatform } from '@/src/lib/authMethods';

const CACHE_KEY = 'auth:methods:v1';
/** Never hold the login screen on a spinner longer than this. */
const READY_TIMEOUT_MS = 2500;

const platform: ClientPlatform = Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'web';

/**
 * The admin's sign-in / sign-up switches for THIS platform.
 *
 * Shares the app-wide `["app-config"]` query (one request for every consumer) but
 * refetches whenever an auth screen mounts, so a switch flipped minutes ago is
 * honoured. The last known answer is kept on the device, so a returning user sees
 * the right buttons at once instead of a "Connecting…" screen; first launch with
 * no network falls back to permissive defaults (the server still enforces).
 */
export function useAuthMethods(): { methods: ClientAuthMethods; ready: boolean } {
  const { data, isFetched } = useQuery({
    queryKey: APP_CONFIG_QUERY_KEY,
    // Same fetcher as useAppConfig: one cache entry must have one shape.
    queryFn: () => fetchAppConfig(),
    staleTime: 20_000,
    refetchOnMount: 'always',
    structuralSharing: (prev: unknown, next: unknown) => newerConfig(prev as any, next as any) as any,
  });
  const [cached, setCached] = useState<ClientAuthMethods | null>(null);
  const [cacheRead, setCacheRead] = useState(false);
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    let alive = true;
    AsyncStorage.getItem(CACHE_KEY)
      .then((raw) => {
        if (alive && raw) setCached({ ...FALLBACK_AUTH_METHODS, ...JSON.parse(raw) });
      })
      .catch(() => {})
      .finally(() => alive && setCacheRead(true));
    const t = setTimeout(() => alive && setTimedOut(true), READY_TIMEOUT_MS);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, []);

  const live = useMemo(() => (data ? resolveClientAuthMethods(data, platform) : null), [data]);

  useEffect(() => {
    if (live) AsyncStorage.setItem(CACHE_KEY, JSON.stringify(live)).catch(() => {});
  }, [live]);

  const methods = live ?? cached ?? FALLBACK_AUTH_METHODS;
  const ready = !!live || isFetched || (cacheRead && !!cached) || timedOut;
  return { methods, ready };
}
