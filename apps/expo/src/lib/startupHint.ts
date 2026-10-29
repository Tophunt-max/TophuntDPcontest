/**
 * Status line for the startup splash while a saved login restores
 * (components/system/AuthStartupGate.tsx). Calm wording, no buttons: Firebase
 * keeps the saved login on a network failure and finishes on its own.
 */

/** After this long on the splash, say why we are still waiting. */
export const STARTUP_SLOW_HINT_MS = 6_000;

/** `connected` is NetInfo's `isConnected`: null until the first probe. */
export function startupHint(slow: boolean, connected: boolean | null): string | null {
  if (connected === false) return 'Internet connection nahi hai. Connect hote hi app khul jayega.';
  if (slow) return 'Connection slow hai, aapka account load ho raha hai…';
  return null;
}
