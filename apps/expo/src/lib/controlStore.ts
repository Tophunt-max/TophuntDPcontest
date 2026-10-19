import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';

/**
 * This device's App Control choices: staff "enter anyway" during maintenance
 * (session only), the soft-update "later" (24h, per minimum version) and the
 * dismissed announcement (by id, persisted). One tiny store so the guard, the
 * screens and the banners see the same thing.
 */
export interface ControlChoices {
  staffBypass: boolean;
  snoozedUpdateFor: string | null;
  dismissedAnnouncementId: string | null;
  dismissedUpcomingAt: number | null;
  hydrated: boolean;
}

const SNOOZE_KEY = 'appControl:updateSnooze:v1';
const BANNER_KEY = 'tophunt.dismissedAnnouncementBanner';
export const UPDATE_SNOOZE_MS = 24 * 3_600_000;

let state: ControlChoices = {
  staffBypass: false,
  snoozedUpdateFor: null,
  dismissedAnnouncementId: null,
  dismissedUpcomingAt: null,
  hydrated: false,
};
const listeners = new Set<() => void>();
const set = (patch: Partial<ControlChoices>) => {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
};

export function getControlChoices(): ControlChoices {
  return state;
}

export async function hydrateControlChoices(): Promise<void> {
  try {
    const [snoozeRaw, dismissed] = await Promise.all([AsyncStorage.getItem(SNOOZE_KEY), AsyncStorage.getItem(BANNER_KEY)]);
    let snoozedUpdateFor: string | null = null;
    if (snoozeRaw) {
      const s = JSON.parse(snoozeRaw);
      if (s && typeof s.v === 'string' && Number(s.until) > Date.now()) snoozedUpdateFor = s.v;
    }
    set({ snoozedUpdateFor, dismissedAnnouncementId: dismissed || null, hydrated: true });
  } catch {
    set({ hydrated: true });
  }
}

export function setStaffBypass(on: boolean): void {
  set({ staffBypass: on });
}

export function snoozeUpdate(minVersion: string): void {
  set({ snoozedUpdateFor: minVersion });
  void AsyncStorage.setItem(SNOOZE_KEY, JSON.stringify({ v: minVersion, until: Date.now() + UPDATE_SNOOZE_MS })).catch(() => {});
}

export function dismissAnnouncement(id: string): void {
  set({ dismissedAnnouncementId: id });
  void AsyncStorage.setItem(BANNER_KEY, id).catch(() => {});
}

export function dismissUpcomingMaintenance(startAt: number): void {
  set({ dismissedUpcomingAt: startAt });
}

export function useControlChoices(): ControlChoices {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
    () => state,
  );
}
