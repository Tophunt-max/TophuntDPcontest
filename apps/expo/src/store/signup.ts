// src/store/signup.ts
import { create } from "zustand";
import AsyncStorage from "@react-native-async-storage/async-storage";

// NOTE: persistence is done MANUALLY here rather than via `zustand/middleware`.
// `zustand/middleware` (persist/devtools) uses `import.meta.env`, which the Expo
// web static export bundles into a classic (non-module) <script>, throwing
// "Cannot use 'import.meta' outside a module" and blanking the whole web app.
// Manual AsyncStorage persistence avoids that dependency entirely.

interface SignupData {
  fullName: string;
  username: string;
  dob: string;
  email: string;
  phone: string;
  occupation: string;
  avatarUrl: string | null;
  gender: string;
  following: string[];
  password?: string;
  referralCode?: string;
  authProvider: 'email' | 'phone' | 'google' | 'facebook' | 'apple';
  // Captured silently on the fill-profile step and used to sort suggested
  // users by proximity on the follow-someone step.
  coordinates?: { lat: number; lng: number };
}

/** Resumable-draft lifetime. After this the saved wizard is discarded. */
export const SIGNUP_DRAFT_TTL_MS = 48 * 60 * 60 * 1000; // 48h
const STORAGE_KEY = "signup-draft";

/** Route for a given furthest-reached wizard step (used to resume). */
export const SIGNUP_STEP_ROUTE: Record<number, string> = {
  1: "/auth/signup",
  2: "/auth/signup/fill-profile",
  3: "/auth/signup/follow-someone",
  4: "/auth/signup/congratulations",
};

interface SignupStore {
  data: Partial<SignupData>;
  /** Furthest wizard step the user has reached (1..4). */
  step: number;
  /** When the draft was last updated (epoch ms); null when empty. */
  savedAt: number | null;
  /** True once the persisted draft has been loaded from disk. */
  _hydrated: boolean;
  setField: (key: keyof SignupData, value: any) => void;
  setMultiple: (obj: Partial<SignupData>) => void;
  setStep: (step: number) => void;
  reset: () => void;
  hasResumableDraft: () => boolean;
}

export const useSignupStore = create<SignupStore>((set, get) => ({
  data: {
    following: [],
  },
  step: 1,
  savedAt: null,
  _hydrated: false,

  setField: (key, value) => {
    set((state) => ({ data: { ...state.data, [key]: value }, savedAt: Date.now() }));
    persistDraft();
  },

  setMultiple: (obj) => {
    set((state) => ({ data: { ...state.data, ...obj }, savedAt: Date.now() }));
    persistDraft();
  },

  setStep: (step) => {
    set((state) => ({ step: Math.max(state.step, step), savedAt: Date.now() }));
    persistDraft();
  },

  reset: () => {
    set({ data: { following: [] }, step: 1, savedAt: null });
    AsyncStorage.removeItem(STORAGE_KEY).catch(() => {});
  },

  hasResumableDraft: () => {
    const { data, savedAt, step } = get();
    return (
      !!savedAt &&
      Date.now() - savedAt < SIGNUP_DRAFT_TTL_MS &&
      step > 1 &&
      !!data.username &&
      (data.authProvider ?? "email") === "email"
    );
  },
}));

/**
 * Write the current draft to disk. The password is NEVER persisted — it lives
 * only in memory for the session and is re-entered on resume.
 */
function persistDraft() {
  const { data, step, savedAt } = useSignupStore.getState();
  const { password, ...safeData } = data;
  const payload = JSON.stringify({ data: safeData, step, savedAt });
  AsyncStorage.setItem(STORAGE_KEY, payload).catch(() => {});
}

// Hydrate the persisted draft once at module load. Expired drafts are discarded.
(async () => {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      const savedAt = parsed?.savedAt ?? null;
      if (savedAt && Date.now() - savedAt < SIGNUP_DRAFT_TTL_MS) {
        useSignupStore.setState({
          data: { following: [], ...(parsed.data || {}) },
          step: parsed.step || 1,
          savedAt,
        });
      } else {
        await AsyncStorage.removeItem(STORAGE_KEY);
      }
    }
  } catch {
    /* ignore corrupt draft */
  } finally {
    useSignupStore.setState({ _hydrated: true });
  }
})();
