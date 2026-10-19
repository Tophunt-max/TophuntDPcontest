import { useQuery, type QueryClient } from '@tanstack/react-query';
import { readApiLive } from '@/src/services/api';
import { useAppConfig } from '@/src/services/appSettings';
import { coinRate, markBestValue, type CoinPackage } from '@/src/lib/coinValue';

export const COIN_PACKAGES_QUERY_KEY = ['coin-packages'] as const;

/** Newest pushed catalog version applied on this device (a late push never undoes a newer one). */
let lastPushedVersion = 0;

/**
 * The live coin-package catalog (wallet store + manual deposit).
 *
 * Fetched without any cache and refetched whenever a store screen opens; an
 * admin add / edit / delete is also pushed over realtime (LiveAppConfig →
 * `applyCoinPackages`), so prices change on screen within seconds.
 */
export function useCoinPackages() {
  return useQuery({
    queryKey: COIN_PACKAGES_QUERY_KEY,
    queryFn: async () => (await readApiLive('/read/coin-packages', { _: Date.now() })) as CoinPackage[],
    staleTime: 15_000,
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
    select: markBestValue,
  });
}

export function applyCoinPackages(queryClient: QueryClient, packages: unknown, version: unknown): void {
  if (!Array.isArray(packages)) return;
  const v = Number(version) || 0;
  if (v && v < lastPushedVersion) return;
  lastPushedVersion = Math.max(lastPushedVersion, v);
  queryClient.setQueryData(COIN_PACKAGES_QUERY_KEY, packages as CoinPackage[]);
}

/** ₹ per coin (live), or null when not configured. */
export function useCoinRate(): number | null {
  const { config } = useAppConfig();
  return coinRate(config);
}
