import { AppState, Platform } from 'react-native';
import { useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { API_BASE_URL } from './api';
import { currentAppVersion } from './appSettings';
import { setUsageEnabledFlag, setUsageSink, usageBuffer, usageEnabled } from '@/src/lib/usageStats';

export { trackUsage } from '@/src/lib/usageStats';

/**
 * Anonymous usage counters: when they are sent, and the user's opt-out. What is
 * counted is in src/lib/usageStats.ts.
 *
 * - Sent to `/telemetry/events` without auth, so a batch is not tied to an
 *   account. Fields: platform, app version, and the counters.
 * - Sent when the app goes to the background, or 5 minutes after the first
 *   counter of a window. Each send is one Worker request, so this stays far below
 *   one request per user-minute.
 * - Off switch: Settings › Privacy. Stored on the device; while off nothing is
 *   counted or sent. Until the stored choice is read, counters are buffered but
 *   not sent.
 * - A failed send is dropped: these are statistics, not data worth a retry queue.
 */

const STORAGE_KEY = 'tophunt.usageStats';
const FLUSH_AFTER_MS = 5 * 60_000;

let hydrated = false;
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function platform(): string {
  return Platform.OS === 'ios' || Platform.OS === 'android' || Platform.OS === 'web' ? Platform.OS : 'other';
}

function cancelTimer() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

export async function flushUsage(): Promise<void> {
  cancelTimer();
  if (!usageEnabled() || !hydrated || usageBuffer.size === 0) return;
  const events = usageBuffer.take();
  try {
    await fetch(`${API_BASE_URL}/telemetry/events`, {
      method: 'POST',
      // text/plain keeps it a "simple" request on web (no CORS preflight).
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify({ platform: platform(), v: currentAppVersion(), events }),
      keepalive: true,
    });
  } catch {
    /* dropped */
  }
}

async function hydrateUsagePreference(): Promise<void> {
  if (hydrated) return;
  let on = true;
  try {
    on = (await AsyncStorage.getItem(STORAGE_KEY)) !== 'off';
  } catch {
    /* default on */
  }
  hydrated = true;
  setUsageEnabledFlag(on);
  for (const l of listeners) l();
}

export async function setUsageEnabled(next: boolean): Promise<void> {
  setUsageEnabledFlag(next);
  if (!next) cancelTimer();
  for (const l of listeners) l();
  try {
    await AsyncStorage.setItem(STORAGE_KEY, next ? 'on' : 'off');
  } catch (e) {
    console.warn('[usage] could not persist preference', e);
  }
}

export function useUsageEnabled(): boolean {
  const [value, setValue] = useState(usageEnabled());
  useEffect(() => {
    const l = () => setValue(usageEnabled());
    listeners.add(l);
    l();
    return () => {
      listeners.delete(l);
    };
  }, []);
  return value;
}

let started = false;
/** Read the stored choice, schedule sends, send on background. Called once at app start. */
export function startUsageStats(): void {
  if (started) return;
  started = true;
  setUsageSink(() => {
    if (!timer) timer = setTimeout(() => void flushUsage(), FLUSH_AFTER_MS);
  });
  void hydrateUsagePreference();
  AppState.addEventListener('change', (s) => {
    if (s !== 'active') void flushUsage();
  });
}
