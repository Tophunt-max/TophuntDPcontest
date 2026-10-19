import Constants from "expo-constants";
import { useQuery, type QueryClient } from "@tanstack/react-query";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { readApi, readApiLive } from "./api";
import { compareVersions as compareVersionsStrict, newerConfig } from "@/src/lib/appControl";

export interface AppConfig {
  appName: string;
  appVersion: string;
  maintenanceMode: boolean;
  maintenanceMessage?: string;
  // Force update
  forceUpdate?: boolean;
  minAppVersion?: string;
  updateUrl?: string;
  // Announcement banner
  announcement?: { enabled?: boolean; message?: string; link?: string };
  // Feature flags — a feature is ON unless explicitly set to false.
  features?: Record<string, boolean>;
  // Withdrawal config
  withdrawal?: {
    enabled?: boolean;
    payoutsFrozen?: boolean;
    minAmount?: number;
    maxAmount?: number;
    maxPerDay?: number;
    conversionRate?: number;
  };
  /** Bumped on every admin save; the newer copy wins. */
  version?: number;
  splashImageUrl?: string;
  headerLogoUrl?: string;
  /** First-launch intro slides, managed from the admin panel's Onboarding page. Empty = built-in. */
  onboarding?: {
    title: string;
    description?: string;
    /** "" = the built-in art for that position. */
    imageUrl?: string;
  }[];
  /** false = an admin switched the intro off. */
  onboardingEnabled?: boolean;
  legalSettings?: {
    termsOfService?: string;
    privacyPolicy?: string;
  };
  [key: string]: any;
}

/** A feature is enabled unless the admin explicitly turned it off. */
export function isFeatureEnabled(config: AppConfig | null | undefined, key: string): boolean {
  return config?.features?.[key] !== false;
}

/**
 * Version compare: -1, 0 or 1. Tolerates a leading "v" and pre-release tags
 * ("v1.4.0-beta" == 1.4.0), which used to parse as 0.4.0 and never trigger.
 */
export function compareVersions(a: string, b: string): number {
  return compareVersionsStrict(a, b);
}

/** The current installed app version (from app.json / expo config). */
export function currentAppVersion(): string {
  return Constants.expoConfig?.version || (Constants as any).manifest?.version || "0.0.0";
}

/** True when a force-update is required (forceUpdate on AND version too old). */
export function isUpdateRequired(config: AppConfig | null | undefined): boolean {
  if (!config?.forceUpdate || !config.minAppVersion) return false;
  return compareVersions(currentAppVersion(), config.minAppVersion) < 0;
}

/** Hook: is a given feature flag enabled right now? (defaults ON while loading) */
export function useFeature(key: string): boolean {
  const { config } = useAppConfig();
  return isFeatureEnabled(config, key);
}

export const APP_CONFIG_QUERY_KEY = ["app-config"] as const;
const PERSIST_KEY = "app-config:last:v1";

/**
 * Fetch the live config. Throws on failure, so react-query KEEPS the last good
 * copy: returning null here (as it used to) made one network blip read as
 * "maintenance off, every feature on" and let users back into a closed app.
 * Bypasses every HTTP cache, and records the server/device clock difference so
 * scheduled maintenance switches at the server's minute, not the phone's.
 */
export async function fetchAppConfig(): Promise<AppConfig> {
  const t0 = Date.now();
  const cfg = (await readApiLive("/read/app-config", { _: t0 })) as AppConfig;
  const serverTime = Number((cfg as any)?.serverTime);
  return {
    ...cfg,
    _skewMs: Number.isFinite(serverTime) ? serverTime - Math.round((t0 + Date.now()) / 2) : 0,
  } as AppConfig;
}

/** Keep the newer of the cached and incoming config, and remember it on the device. */
export function applyAppConfig(queryClient: QueryClient, incoming: AppConfig | null | undefined): void {
  if (!incoming) return;
  const next = newerConfig(queryClient.getQueryData<AppConfig>(APP_CONFIG_QUERY_KEY) as any, incoming as any);
  queryClient.setQueryData(APP_CONFIG_QUERY_KEY, next);
  void AsyncStorage.setItem(PERSIST_KEY, JSON.stringify(next)).catch(() => {});
}

/**
 * Seed the cache from the last config this device saw, so a cold start with no
 * network still honours maintenance / disabled features instead of failing open.
 */
export async function hydrateAppConfig(queryClient: QueryClient): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(PERSIST_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (!queryClient.getQueryData(APP_CONFIG_QUERY_KEY)) {
      // Stale on purpose (updatedAt 0), so the first mount still fetches.
      queryClient.setQueryData(APP_CONFIG_QUERY_KEY, saved, { updatedAt: 0 });
    }
  } catch {
    /* nothing saved, or unreadable */
  }
}

/**
 * App config, shared by every consumer through ONE react-query cache entry.
 *
 * Kept live by three things (src/components/system/LiveAppConfig.tsx):
 *  - an admin save pushes the new config over realtime (seconds);
 *  - returning to the app / regaining the network refetches;
 *  - a 60s safety poll while the app is in the foreground.
 * A pushed copy and a polled copy are merged by `version`, newest wins.
 */
export function useAppConfig() {
  const { data, isLoading } = useQuery({
    queryKey: APP_CONFIG_QUERY_KEY,
    queryFn: async () => {
      const fresh = await fetchAppConfig();
      void AsyncStorage.setItem(PERSIST_KEY, JSON.stringify(fresh)).catch(() => {});
      return fresh;
    },
    staleTime: 20_000,
    refetchInterval: 60_000,
    refetchOnMount: false,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    // A polled answer must never replace a newer pushed one.
    structuralSharing: (prev: unknown, next: unknown) => newerConfig(prev as any, next as any) as any,
  });
  return { config: (data as AppConfig) ?? null, loading: isLoading && !data };
}

// One-time fetch (used in splash / onboarding). Null on error: those callers
// only read cosmetic fields and fall back to built-ins.
export async function getAppConfig(): Promise<AppConfig | null> {
  try {
    return (await readApi("/read/app-config")) as AppConfig;
  } catch (error) {
    console.error("Error in getAppConfig:", error);
    return null;
  }
}
