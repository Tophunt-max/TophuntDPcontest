// src/store/signup.ts
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import AsyncStorage from "@react-native-async-storage/async-storage";

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
  setField: (key: keyof SignupData, value: any) => void;
  setMultiple: (obj: Partial<SignupData>) => void;
  setStep: (step: number) => void;
  reset: () => void;
  /**
   * True when there is a non-expired email-signup draft worth resuming (the
   * user got past step 1 and filled some profile data). Social/phone signups
   * are excluded because they need a live auth session that can't be resumed
   * purely from persisted data.
   */
  hasResumableDraft: () => boolean;
}

export const useSignupStore = create<SignupStore>()(
  persist(
    (set, get) => ({
      data: {
        following: [],
      },
      step: 1,
      savedAt: null,

      setField: (key, value) =>
        set((state) => ({
          data: { ...state.data, [key]: value },
          savedAt: Date.now(),
        })),

      setMultiple: (obj) =>
        set((state) => ({
          data: { ...state.data, ...obj },
          savedAt: Date.now(),
        })),

      setStep: (step) =>
        set((state) => ({
          step: Math.max(state.step, step),
          savedAt: Date.now(),
        })),

      reset: () =>
        set({
          data: { following: [] },
          step: 1,
          savedAt: null,
        }),

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
    }),
    {
      name: "signup-draft",
      storage: createJSONStorage(() => AsyncStorage),
      // SECURITY: never write the password to disk. It lives only in memory for
      // the current session and is re-entered on resume.
      partialize: (state) => {
        const { password, ...safeData } = state.data;
        return { data: safeData, step: state.step, savedAt: state.savedAt };
      },
      // Discard an expired draft on rehydration so stale/abandoned signups don't
      // silently resurface days later.
      onRehydrateStorage: () => (state) => {
        if (state?.savedAt && Date.now() - state.savedAt > SIGNUP_DRAFT_TTL_MS) {
          state.reset();
        }
      },
    },
  ),
);
