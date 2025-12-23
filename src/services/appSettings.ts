import { doc, getDoc, getDocFromCache, getDocFromServer } from "firebase/firestore";
import { firestore } from "./firebase/initFirebase";

export interface AppConfig {
  appName: string;
  appVersion: string;
  maintenanceMode: boolean;
  splashImageUrl?: string;
  onboarding?: {
    title: string;
    description: string;
    imageUrl: string;
  }[];
}

export async function getAppConfig(): Promise<AppConfig | null> {
  try {
    const docRef = doc(firestore, "settings", "appConfig");
    
    // Try to get from server first, but with a timeout or just catching the offline error
    try {
        const docSnap = await getDocFromServer(docRef);
        if (docSnap.exists()) {
            return docSnap.data() as AppConfig;
        }
    } catch (serverError) {
        // If server fetch fails (like offline), try fetching from local cache
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
    // This catch blocks any other unexpected errors and prevents the red screen
    console.error("Error in getAppConfig:", error);
    return null;
  }
}
