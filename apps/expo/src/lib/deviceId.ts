import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';

const STORAGE_KEY = 'tophunt.deviceId';
let cached: string | null = null;

/**
 * A stable, per-installation identifier used for vote de-duplication and abuse
 * detection on the server.
 *
 * It is generated once (a random UUID) and persisted in AsyncStorage so it
 * survives app restarts. This is intentionally NOT a hardware identifier: it
 * resets on reinstall, which is the privacy-friendly and app-store-compliant
 * choice. Previously the app sent a hardcoded 'device-id' / 'unknown', which
 * defeated any device-based duplicate-vote protection.
 */
export async function getDeviceId(): Promise<string> {
  if (cached) return cached;
  try {
    const existing = await AsyncStorage.getItem(STORAGE_KEY);
    if (existing) {
      cached = existing;
      return existing;
    }
    const id = Crypto.randomUUID();
    await AsyncStorage.setItem(STORAGE_KEY, id);
    cached = id;
    return id;
  } catch {
    // Storage unavailable — fall back to an ephemeral id for this session so
    // callers always get a non-empty value.
    const fallback: string = cached ?? Crypto.randomUUID();
    cached = fallback;
    return fallback;
  }
}
