import { useEffect, useState } from 'react';
import { Appearance, type ColorSchemeName } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * App-level theme preference.
 *
 * The Settings screen had a Dark Mode switch that moved and did nothing: it
 * toggled a local `useState` while every screen read the OS setting directly via
 * `useColorScheme()` from react-native. The value was never applied and never
 * persisted.
 *
 * This makes the preference real:
 *  - `system` (default) follows the OS, which is what users expect;
 *  - `light` / `dark` override it for the whole app and survive a restart.
 *
 * Implemented as a tiny external store rather than React context so the shared
 * `useColorScheme()` hook stays a drop-in replacement for the react-native one —
 * no provider needs to wrap the tree, and the ~45 existing call sites keep
 * working unchanged.
 */

export type ThemePreference = 'system' | 'light' | 'dark';

const STORAGE_KEY = 'tophunt.themePreference';

let preference: ThemePreference = 'system';
let hydrated = false;
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

/** Load the persisted preference. Called once at app start. */
export async function hydrateThemePreference(): Promise<void> {
  if (hydrated) return;
  try {
    const stored = await AsyncStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'system') preference = stored;
  } catch {
    /* fall back to system */
  } finally {
    hydrated = true;
    notify();
  }
}

export function getThemePreference(): ThemePreference {
  return preference;
}

export async function setThemePreference(next: ThemePreference): Promise<void> {
  preference = next;
  notify();
  try {
    await AsyncStorage.setItem(STORAGE_KEY, next);
  } catch (e) {
    // The in-memory value already applied; only persistence failed.
    console.warn('[theme] could not persist preference', e);
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * The resolved scheme: the override when set, otherwise the OS value.
 *
 * Subscribes to BOTH the preference store and OS appearance changes, so
 * switching the system theme while on `system` updates live.
 */
export function useResolvedColorScheme(): ColorSchemeName {
  const [, forceRender] = useState(0);
  const [systemScheme, setSystemScheme] = useState<ColorSchemeName>(
    () => Appearance.getColorScheme() ?? 'light',
  );

  useEffect(() => {
    const unsubscribePreference = subscribe(() => forceRender((n) => n + 1));
    const appearance = Appearance.addChangeListener(({ colorScheme }) => {
      setSystemScheme(colorScheme ?? 'light');
    });
    return () => {
      unsubscribePreference();
      appearance.remove();
    };
  }, []);

  if (preference === 'light' || preference === 'dark') return preference;
  return systemScheme;
}

/** Reactive accessor for the preference itself (for the settings UI). */
export function useThemePreference(): ThemePreference {
  const [value, setValue] = useState<ThemePreference>(preference);
  useEffect(() => subscribe(() => setValue(preference)), []);
  return value;
}
