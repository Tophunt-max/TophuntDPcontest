import { useState, useEffect } from "react";
import Constants from "expo-constants";
import { readApi, poll } from "./api";

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
  withdrawal?: { enabled?: boolean; minAmount?: number; conversionRate?: number };
  splashImageUrl?: string;
  headerLogoUrl?: string;
  onboarding?: {
    title: string;
    description: string;
    imageUrl: string;
  }[];
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

/** Semantic-ish version compare: returns -1, 0, or 1 for a<b, a==b, a>b. */
export function compareVersions(a: string, b: string): number {
  const pa = String(a || "0").split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b || "0").split(".").map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
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

// Real-time updates via polling (was Firestore onSnapshot on settings/appConfig).
export function useAppConfig() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsubscribe = poll<AppConfig>(
      () => readApi("/read/app-config"),
      (data) => {
        if (data) setConfig(data);
        setLoading(false);
      },
      30000,
    );
    return () => unsubscribe();
  }, []);

  return { config, loading };
}

// One-time fetch (used in splash / onboarding).
export async function getAppConfig(): Promise<AppConfig | null> {
  try {
    return (await readApi("/read/app-config")) as AppConfig;
  } catch (error) {
    console.error("Error in getAppConfig:", error);
    return null;
  }
}
