type Extra = Record<string, any>;

/**
 * Central crash/error reporter — the single place to wire a monitoring
 * provider. Today it logs to the console; enabling Sentry is a one-line change
 * here (see apps/expo/PRODUCTION_TODO.md).
 *
 * To enable Sentry:
 *   1. npm i @sentry/react-native
 *   2. In app/_layout.tsx: Sentry.init({ dsn: process.env.EXPO_PUBLIC_SENTRY_DSN })
 *   3. Below, replace the console call with:
 *        Sentry.captureException(error, { extra });
 */
export function reportError(error: unknown, extra?: Extra) {
  const message = error instanceof Error ? error.message : String(error);
  if (__DEV__) {
    console.error('[reportError]', message, extra ?? '');
  } else {
    console.error('[reportError]', message);
  }
}
