// src/store/signup.ts
import { create } from "zustand";

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

interface SignupStore {
  data: Partial<SignupData>;
  setField: (key: keyof SignupData, value: any) => void;
  setMultiple: (obj: Partial<SignupData>) => void;
  reset: () => void;
}

export const useSignupStore = create<SignupStore>((set) => ({
  data: {
    following: [],
  },

  setField: (key, value) =>
    set((state) => ({
      data: {
        ...state.data,
        [key]: value,
      },
    })),

  setMultiple: (obj) =>
    set((state) => ({
      data: {
        ...state.data,
        ...obj,
      },
    })),

  reset: () =>
    set({
      data: {
        following: [],
      },
    }),
}));
