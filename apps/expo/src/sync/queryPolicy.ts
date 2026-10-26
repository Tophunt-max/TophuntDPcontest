import { ApiCallError, isCancelledError } from '@/src/services/api';

/**
 * React Query retry policy.
 *
 * `request()` in src/services/api.ts already retries reads that failed in
 * transit or with 429/5xx, up to READ_RETRIES times with backoff. React
 * Query's own `retry: 2` ran on top of that, so one query could make up to
 * nine attempts, each allowed the 20 s timeout. Retrying here only for errors
 * that did NOT come from the request core (for example, a queryFn that threw
 * while shaping the data) keeps the worst case at three attempts.
 */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiCallError) return false;
  return failureCount < 2;
}

/** A cancelled query is the caller changing its mind, not an error to report. */
export function shouldReportQueryError(error: unknown): boolean {
  return !isCancelledError(error);
}
