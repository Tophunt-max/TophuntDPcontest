import { useEffect } from 'react';
import { AppState, Platform } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import { subscribeChannel } from '@/src/services/realtime';
import { onControlSignal, setClientVersionHeaders } from '@/src/services/api';
import { APP_CONFIG_QUERY_KEY, applyAppConfig, currentAppVersion, hydrateAppConfig } from '@/src/services/appSettings';
import { hydrateControlChoices } from '@/src/lib/controlStore';

/** Must match the Worker's APP_CONFIG_SHARDS (lib/appControl.ts). */
const APP_CONFIG_SHARDS = 16;
const SHARD = Math.floor(Math.random() * APP_CONFIG_SHARDS);

/**
 * Keeps App Control live on this device. Renders nothing.
 *
 *  - Listens on `app:cfg<N>`: an admin save pushes the full public config, which
 *    is applied at once (newest version wins) — maintenance, flags and the banner
 *    change in seconds, for signed-in users and guests alike.
 *  - Coming back to the app refetches (a socket may have slept in the background).
 *  - A server refusal tagged maintenance / update_required / feature_disabled
 *    refetches too, so the screen catches up with what the server just said.
 */
export function LiveAppConfig() {
  const queryClient = useQueryClient();

  useEffect(() => {
    setClientVersionHeaders(Platform.OS, currentAppVersion());
    void hydrateAppConfig(queryClient);
    void hydrateControlChoices();
  }, [queryClient]);

  useEffect(() => {
    const unsubscribe = subscribeChannel(`app:cfg${SHARD}`, (event) => {
      if (event.type === 'config' && event.config && typeof event.config === 'object') {
        const serverTime = Number(event.config.serverTime);
        applyAppConfig(queryClient, {
          ...event.config,
          _skewMs: Number.isFinite(serverTime) ? serverTime - Date.now() : 0,
        });
      }
    });
    return unsubscribe;
  }, [queryClient]);

  useEffect(() => {
    const refetch = () => void queryClient.invalidateQueries({ queryKey: APP_CONFIG_QUERY_KEY });
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') refetch();
    });
    const off = onControlSignal(() => refetch());
    return () => {
      sub.remove();
      off();
    };
  }, [queryClient]);

  return null;
}

export default LiveAppConfig;
