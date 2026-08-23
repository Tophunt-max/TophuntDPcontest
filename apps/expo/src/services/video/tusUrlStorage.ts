import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * AsyncStorage-backed URL storage for tus-js-client.
 *
 * tus-js-client only remembers in-flight uploads when it has a URL storage. Its
 * default implementation uses `localStorage`, which does not exist on React
 * Native, so `tus.canStoreURLs` is false there and resuming silently degrades to
 * restarting from byte zero — exactly the behaviour the migration was meant to
 * fix on flaky mobile connections.
 *
 * Keys are namespaced so they never collide with the rest of the app's storage.
 */

const PREFIX = 'tus::';

interface PreviousUpload {
  size: number | null;
  metadata: Record<string, string>;
  creationTime: string;
  urlStorageKey: string;
  uploadUrl: string | null;
  parallelUploadUrls: string[] | null;
}

export class AsyncStorageUrlStorage {
  async findAllUploads(): Promise<PreviousUpload[]> {
    const keys = (await AsyncStorage.getAllKeys()).filter((k) => k.startsWith(PREFIX));
    if (!keys.length) return [];
    const entries = await AsyncStorage.multiGet(keys);
    return entries
      .map(([key, value]) => this.parse(key, value))
      .filter((u): u is PreviousUpload => u !== null);
  }

  async findUploadsByFingerprint(fingerprint: string): Promise<PreviousUpload[]> {
    const key = PREFIX + fingerprint;
    const value = await AsyncStorage.getItem(key);
    const parsed = this.parse(key, value);
    return parsed ? [parsed] : [];
  }

  async removeUpload(urlStorageKey: string): Promise<void> {
    await AsyncStorage.removeItem(urlStorageKey);
  }

  async addUpload(fingerprint: string, upload: PreviousUpload): Promise<string> {
    const urlStorageKey = PREFIX + fingerprint;
    await AsyncStorage.setItem(urlStorageKey, JSON.stringify({ ...upload, urlStorageKey }));
    return urlStorageKey;
  }

  private parse(key: string, value: string | null): PreviousUpload | null {
    if (!value) return null;
    try {
      const parsed = JSON.parse(value);
      // Always trust the real key over whatever was serialized, so a renamed or
      // hand-edited entry can still be removed.
      return { ...parsed, urlStorageKey: key };
    } catch {
      return null;
    }
  }
}

export const tusUrlStorage = new AsyncStorageUrlStorage();
