/**
 * Error + response helpers that preserve the semantics of Firebase callable
 * functions (HttpsError codes) so client error handling keeps working.
 */
import { ContentfulStatusCode } from "hono/utils/http-status";

export type ErrorCode =
  | "ok"
  | "invalid-argument"
  | "unauthenticated"
  | "permission-denied"
  | "not-found"
  | "already-exists"
  | "failed-precondition"
  | "deadline-exceeded"
  | "internal";

const CODE_TO_STATUS: Record<ErrorCode, number> = {
  ok: 200,
  "invalid-argument": 400,
  unauthenticated: 401,
  "permission-denied": 403,
  "not-found": 404,
  "already-exists": 409,
  "failed-precondition": 412,
  "deadline-exceeded": 504,
  internal: 500,
};

/** Mirror of Firebase functions HttpsError. */
export class ApiError extends Error {
  code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
  }
  get status(): ContentfulStatusCode {
    return (CODE_TO_STATUS[this.code] ?? 500) as ContentfulStatusCode;
  }
}

export const httpsError = (code: ErrorCode, message: string) => new ApiError(code, message);

/** Serialize an ApiError to the shape the Firebase client SDK expects. */
export function errorBody(err: ApiError) {
  return {
    error: {
      status: err.code.toUpperCase().replace(/-/g, "_"),
      message: err.message,
    },
  };
}
