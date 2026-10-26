import { useEffect, useState } from 'react';
import { AccessibilityInfo, AppState, type AppStateStatus } from 'react-native';

/** True while the app is in the foreground. */
export function useAppActive(): boolean {
  const [active, setActive] = useState(AppState.currentState === 'active');
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s: AppStateStatus) => setActive(s === 'active'));
    return () => sub.remove();
  }, []);
  return active;
}

/** The OS "reduce motion" accessibility setting, live. False until known. */
export function useReduceMotion(): boolean {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled?.()
      .then((v) => {
        if (alive) setReduce(!!v);
      })
      .catch(() => undefined);
    const sub = AccessibilityInfo.addEventListener?.('reduceMotionChanged', (v: boolean) => setReduce(!!v));
    return () => {
      alive = false;
      sub?.remove?.();
    };
  }, []);
  return reduce;
}
