import { describe, it, expect, vi, beforeEach } from 'vitest';

// In-memory AsyncStorage + controllable failure, and a deterministic UUID.
const store = new Map<string, string>();
let failStorage = false;
let uuidCounter = 0;

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (k: string) => {
      if (failStorage) throw new Error('storage unavailable');
      return store.has(k) ? store.get(k)! : null;
    },
    setItem: async (k: string, v: string) => {
      if (failStorage) throw new Error('storage unavailable');
      store.set(k, v);
    },
  },
}));

vi.mock('expo-crypto', () => ({ randomUUID: () => `uuid-${++uuidCounter}` }));

beforeEach(() => {
  store.clear();
  failStorage = false;
  uuidCounter = 0;
  vi.resetModules(); // reset the module-level cache in deviceId.ts
});

describe('getDeviceId', () => {
  it('generates and persists a new id when none is stored', async () => {
    const { getDeviceId } = await import('@/src/lib/deviceId');
    const id = await getDeviceId();
    expect(id).toBe('uuid-1');
    expect(store.get('tophunt.deviceId')).toBe('uuid-1');
  });

  it('returns the previously persisted id', async () => {
    store.set('tophunt.deviceId', 'existing-123');
    const { getDeviceId } = await import('@/src/lib/deviceId');
    expect(await getDeviceId()).toBe('existing-123');
  });

  it('is stable within a session (cached, single value)', async () => {
    const { getDeviceId } = await import('@/src/lib/deviceId');
    const a = await getDeviceId();
    const b = await getDeviceId();
    expect(a).toBe(b);
    expect(a).toBe('uuid-1'); // only generated once
  });

  it('falls back to an ephemeral id when storage throws', async () => {
    failStorage = true;
    const { getDeviceId } = await import('@/src/lib/deviceId');
    const id = await getDeviceId();
    expect(id).toMatch(/^uuid-/); // still returns a usable id
  });
});
