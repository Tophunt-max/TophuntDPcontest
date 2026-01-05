import { doc, onSnapshot, getDocFromServer, getDocFromCache } from "firebase/firestore";
import { firestore } from "./firebase/initFirebase";
import { useState, useEffect } from "react";

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
}

// For Real-time updates (Used in Header)
export function useAppConfig() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const docRef = doc(firestore, "settings", "appConfig");
    
    const unsubscribe = onSnapshot(docRef, (docSnap) => {
      if (docSnap.exists()) {
        setConfig(docSnap.data() as AppConfig);
      }
      setLoading(false);
    }, (error) => {
      console.error("Error listening to app config:", error);
      setLoading(false);
    });

    return () => unsubscribe();
  }, []);

  return { config, loading };
}

// For One-time fetch (Used in Splash and Onboarding)
export async function getAppConfig(): Promise<AppConfig | null> {
  try {
    const docRef = doc(firestore, "settings", "appConfig");
    
    try {
        const docSnap = await getDocFromServer(docRef);
        if (docSnap.exists()) {
            return docSnap.data() as AppConfig;
        }
    } catch (serverError) {
        console.warn("Server fetch failed, trying cache:", serverError);
        try {
            const cacheSnap = await getDocFromCache(docRef);
            if (cacheSnap.exists()) {
                return cacheSnap.data() as AppConfig;
            }
        } catch (cacheError) {
            console.error("Cache fetch also failed:", cacheError);
        }
    }

    return null;
  } catch (error) {
    console.error("Error in getAppConfig:", error);
    return null;
  }
}
