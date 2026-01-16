// src/store/signup.ts
import { create } from "zustand";

export interface PhotoDerivatives {
  small: string;
  medium: string;
  full: string;
}

interface SignupData {
  uid?: string; // Unique ID for the user
  fullName: string;
  username: string;
  dob: string;
  email: string;
  phone: string;
  occupation: string;
  avatarUrl: string | null;
  photoDerivatives?: PhotoDerivatives | null; // Added for optimized images
  gender: string;
  following: string[];
  password?: string;
  authProvider: 'email' | 'phone' | 'google' | 'facebook' | 'apple';
  coordinates?: {
    lat: number;
    lng: number;
  };
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
