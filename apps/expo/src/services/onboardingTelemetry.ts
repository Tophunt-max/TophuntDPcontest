import { Platform } from 'react-native';
import { API_BASE_URL } from './api';

/**
 * Anonymous onboarding funnel counters (Worker `POST /telemetry/onboarding`).
 *
 * Nothing identifying is sent — the event, the slide index and the platform —
 * and the Worker only keeps per-day counts. Fire and forget: a failed counter
 * must never slow down or break the intro, so errors are swallowed and the
 * request is not awaited by the screen.
 */
export type OnboardingEvent = 'shown' | 'reached' | 'skipped' | 'completed' | 'login';

export function trackOnboarding(event: OnboardingEvent, slide?: number): void {
  try {
    const platform = Platform.OS === 'ios' || Platform.OS === 'android' || Platform.OS === 'web' ? Platform.OS : 'other';
    void fetch(`${API_BASE_URL}/telemetry/onboarding`, {
      method: 'POST',
      // text/plain keeps it a "simple" request on web: no CORS preflight, which
      // `keepalive` requests cannot always make. The Worker parses the JSON body
      // regardless of the declared type.
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify(slide === undefined ? { event, platform } : { event, slide, platform }),
      // Lets the last event (skip / get started) survive the navigation away on web.
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* never let analytics break the intro */
  }
}
