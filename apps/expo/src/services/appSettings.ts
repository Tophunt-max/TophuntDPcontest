import { useState, useEffect } from "react";
import { readApi, poll } from "./api";

export interface AppConfig {
  appName: string;
  appVersion: string;
  maintenanceMode: boolean;
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
