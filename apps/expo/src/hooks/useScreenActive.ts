import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { useIsFocused } from '@react-navigation/native';

/**
 * True while this screen is focused AND the app is in the foreground. Looping
 * or long animations pause when it turns false, so nothing keeps animating on a
 * backgrounded app or a screen deeper in the stack.
 */
export function useScreenActive(): boolean {
  const focused = useIsFocused();
  const [foreground, setForeground] = useState(AppState.currentState !== 'background' && AppState.currentState !== 'inactive');
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => setForeground(s === 'active'));
    return () => sub.remove();
  }, []);
  return focused && foreground;
}
