/**
 * What a failed request means for something that wants to send it again.
 *
 * Mirrors `request()` in src/services/api.ts: a failure with NO HTTP status
 * never reached the server (offline, DNS, timeout), 429/5xx are the server
 * saying "later", 401 means the session must be fixed first, and any other 4xx
 * is the server refusing this exact request, which a retry cannot change.
 *
 * Deliberately import-free. It recognises `ApiCallError` by shape (a
 * `functions/...` code) rather than `instanceof`, so the Story queue and the
 * outbox can use it without pulling the API client, and React Native, into
 * their import graph.
 */
export type FailureClass = 'retry' | 'auth' | 'duplicate' | 'permanent';

interface ApiErrorShape {
  code: string;
  status?: number;
}

function asApiError(error: unknown): ApiErrorShape | null {
  if (!error || typeof error !== 'object') return null;
  const code = (error as any).code;
  if (typeof code !== 'string' || !code.startsWith('functions/')) return null;
  const status = (error as any).status;
  return { code, status: typeof status === 'number' ? status : undefined };
}

export function classifyFailure(error: unknown): FailureClass {
  const e = asApiError(error);
  if (!e) return 'retry';
  const s = e.status;
  if (s === undefined) return 'retry';
  if (s === 429 || s >= 500) return 'retry';
  if (s === 401) return 'auth';
  // `enforceIdempotency` answers a reused key with 409 already-exists: the
  // first delivery already succeeded.
  if (s === 409) return 'duplicate';
  return 'permanent';
}

/**
 * The request never got an answer from the server. This is the only case where
 * the UI may keep an optimistic change and hand it to the outbox; any HTTP
 * answer (including 5xx) means the server saw it and the UI should follow the
 * server. A caller cancellation is not a network failure.
 */
export function isNetworkFailure(error: unknown): boolean {
  const e = asApiError(error);
  return !!e && e.status === undefined && e.code !== 'functions/cancelled';
}
