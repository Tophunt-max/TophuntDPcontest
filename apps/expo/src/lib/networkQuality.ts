/**
 * Live connection + "Data saver" preference -> the image policy used by every
 * image in the app (src/lib/imageQuality.ts decides; this module observes).
 *
 *  - Native: NetInfo (wifi / cellular + 2G-5G generation + isConnectionExpensive).
 *  - Web: NetInfo plus the Network Information API (`navigator.connection`:
 *    effectiveType, downlink, saveData) where the browser has it (Chrome,
 *    Android browsers; Safari/Firefox simply report nothing and get full quality).
 *  - The user's choice is persisted in AsyncStorage.
 *
 * Applying a new policy only affects images that load AFTER the change: an image
 * already on screen keeps the variant it chose (AppImage locks it), so turning on
 * Data saver never makes the visible feed flash and re-download.
 */
import { useEffect, useState } from 'react';
import { Platform } from 'react-native';
import NetInfo, { type NetInfoState } from '@react-native-community/netinfo';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  FULL_QUALITY,
  imagePolicyFor,
  parseDataSaverMode,
  type DataSaverMode,
  type ImagePolicy,
  type NetworkSnapshot,
} from './imageQuality';
import { setImageQualityPolicy } from './imageVariants';

const STORAGE_KEY = 'settings:dataSaver:v1';

let mode: DataSaverMode = 'off';
let net: NetworkSnapshot = { type: 'unknown' };
let policy: ImagePolicy = FULL_QUALITY;
const listeners = new Set<() => void>();

function recompute() {
  policy = imagePolicyFor(net, mode);
  setImageQualityPolicy(policy);
  listeners.forEach((l) => l());
}

function browserConnection(): any {
  if (Platform.OS !== 'web' || typeof navigator === 'undefined') return null;
  return (navigator as any).connection || (navigator as any).mozConnection || (navigator as any).webkitConnection || null;
}

/** NetInfo state (+ the browser's Network Information API) -> a snapshot. */
export function snapshotFrom(state: NetInfoState | null, conn: any = browserConnection()): NetworkSnapshot {
  const type = (state?.isConnected === false ? 'none' : (state?.type as string)) || 'unknown';
  const details: any = state?.details || {};
  const snap: NetworkSnapshot = {
    type: (['wifi', 'ethernet', 'cellular', 'none'].includes(type) ? type : type === 'unknown' ? 'unknown' : 'other') as any,
    generation: details.cellularGeneration ?? null,
    expensive: !!details.isConnectionExpensive,
  };
  if (conn) {
    snap.saveData = !!conn.saveData;
    snap.effectiveType = conn.effectiveType ?? null;
    snap.downlinkMbps = typeof conn.downlink === 'number' ? conn.downlink : null;
    if (snap.type === 'unknown' || snap.type === 'other') {
      if (conn.type === 'wifi' || conn.type === 'ethernet' || conn.type === 'cellular') snap.type = conn.type;
    }
  }
  return snap;
}

let started = false;

/** Start observing (idempotent). Called once from LiveAppConfig. */
export function startNetworkQuality(): () => void {
  if (started) return () => {};
  started = true;
  // Web can know both synchronously, so the very first images already follow
  // the policy. Native reads AsyncStorage/NetInfo asynchronously; the first
  // frame there may load full quality (a few images at cold start).
  if (Platform.OS === 'web') {
    try {
      mode = parseDataSaverMode(typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null);
    } catch {
      /* storage blocked */
    }
    net = snapshotFrom(null);
    recompute();
  }
  void AsyncStorage.getItem(STORAGE_KEY)
    .then((raw) => {
      mode = parseDataSaverMode(raw);
      recompute();
    })
    .catch(() => undefined);
  const unsubNet = NetInfo.addEventListener((s) => {
    net = snapshotFrom(s);
    recompute();
  });
  const conn = browserConnection();
  const onConn = () => {
    void NetInfo.fetch().then((s) => {
      net = snapshotFrom(s);
      recompute();
    });
  };
  conn?.addEventListener?.('change', onConn);
  return () => {
    started = false;
    unsubNet();
    conn?.removeEventListener?.('change', onConn);
  };
}

export function getImagePolicy(): ImagePolicy {
  return policy;
}

export function getDataSaverMode(): DataSaverMode {
  return mode;
}

export async function setDataSaverMode(next: DataSaverMode): Promise<void> {
  mode = next;
  recompute();
  await AsyncStorage.setItem(STORAGE_KEY, next).catch(() => undefined);
}

/** Live { mode, net, policy } for the Settings screen. */
export function useNetworkQuality(): { mode: DataSaverMode; net: NetworkSnapshot; policy: ImagePolicy } {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return { mode, net, policy };
}
