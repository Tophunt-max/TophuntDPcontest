import { createMiddleware } from "hono/factory";
import { eq } from "drizzle-orm";
import type { Env, Variables } from "../types";
import { verifyIdToken, bearerToken } from "../lib/firebaseAuth";
import { httpsError } from "../lib/http";
import { getDb, schema } from "../db";
import {
  BLOCKED_STATUS,
  DELETED_STATUS,
  PENDING_DELETION_ALLOWED_ACTIONS,
  PENDING_DELETION_STATUS,
  SELF_SERVICE_ACTIONS,
} from "../lib/accountStatus";

type MW = { Bindings: Env; Variables: Variables };

interface AccountState {
  status: string | null;
  isBlocked: boolean | null;
}

function readAccountState(env: Env, uid: string): Promise<AccountState | undefined> {
  return getDb(env)
    .select({ status: schema.users.status, isBlocked: schema.users.isBlocked })
    .from(schema.users)
    .where(eq(schema.users.uid, uid))
    .get() as Promise<AccountState | undefined>;
}

/** Reject an already-issued token as soon as its D1 account is blocked. */
export async function assertAccountNotBlocked(env: Env, uid: string): Promise<void> {
  const account = await readAccountState(env, uid);
  if (account?.status === DELETED_STATUS) {
    throw httpsError("permission-denied", "This account has been deleted.");
  }
  if (account?.isBlocked || account?.status === BLOCKED_STATUS) {
    throw httpsError("permission-denied", "This account has been blocked.");
  }
}

/** Require a valid Firebase ID token and reject blocked accounts immediately. */
export const requireAuth = createMiddleware<MW>(async (c, next) => {
  const token = bearerToken(c.req.header("Authorization"));
  if (!token) throw httpsError("unauthenticated", "User must be logged in.");
  const user = await verifyIdToken(token, c.env);

  // Firebase ID tokens may remain valid for up to an hour after an account is
  // disabled. D1 is the immediate source of truth for immediate revocation.
  await assertAccountNotBlocked(c.env, user.uid);

  c.set("user", user);
  await next();
});

/**
 * Auth for `/api`, which is action-aware.
 *
 * `requireAuth` cannot serve this route, because two of the checks depend on
 * WHICH action is being called and the action name lives in the request body:
 *
 *  1. A blocked account must still be able to delete itself. `requireAuth`
 *     rejected it with a 403 before the router saw the action, the client
 *     rendered that as an error, and the delete button never appeared — leaving
 *     blocked users with no in-app deletion path, which is the exact thing both
 *     app stores require to exist.
 *  2. An account that is pending deletion must be able to cancel, and nothing
 *     else. It is already hidden from every public surface and described to the
 *     user as deleted, so it must not still be able to post or spend.
 *
 * Reading the body here is safe: Hono caches the parsed JSON, so the handler's
 * own `c.req.json()` does not re-read the stream.
 */
export const requireApiAuth = createMiddleware<MW>(async (c, next) => {
  const token = bearerToken(c.req.header("Authorization"));
  if (!token) throw httpsError("unauthenticated", "User must be logged in.");
  const user = await verifyIdToken(token, c.env);

  const body = await c.req.json<any>().catch(() => ({}));
  const action = typeof body?.action === "string" ? body.action : "";

  // Firebase ID tokens stay valid for up to an hour after an account is
  // disabled, so D1 is the source of truth for immediate revocation.
  const account = await readAccountState(c.env, user.uid);

  // Anonymised is terminal. No action, self-service or otherwise, gets back in —
  // there is no longer an account to act on, and `deleteAccount` in particular
  // must not restart a purge that has already completed.
  if (account?.status === DELETED_STATUS) {
    throw httpsError("permission-denied", "This account has been deleted.");
  }

  if (!SELF_SERVICE_ACTIONS.has(action)) {
    if (account?.isBlocked || account?.status === BLOCKED_STATUS) {
      throw httpsError("permission-denied", "This account has been blocked.");
    }
  }

  if (
    account?.status === PENDING_DELETION_STATUS &&
    !PENDING_DELETION_ALLOWED_ACTIONS.has(action)
  ) {
    throw httpsError(
      "failed-precondition",
      "Your account is scheduled for deletion. Cancel the deletion to use TopHunt again.",
    );
  }

  c.set("user", user);
  await next();
});

/** Attach user if a token is present, but don't require it (guest routes). */
export const optionalAuth = createMiddleware<MW>(async (c, next) => {
  const token = bearerToken(c.req.header("Authorization"));
  if (token) {
    try {
      const user = await verifyIdToken(token, c.env);
      await assertAccountNotBlocked(c.env, user.uid);
      c.set("user", user);
    } catch {
      /* ignore — treated as guest */
    }
  }
  await next();
});

/**
 * True if the user is an admin — via the `role` custom claim OR the D1 users
 * row (mirrors utils/firebase.ts isAdmin + firestore.rules).
 */
export async function isAdmin(c: { env: Env; get: (k: "user") => any }): Promise<boolean> {
  const user = c.get("user");
  if (!user?.uid) return false;
  if (user.role === "admin") return true;
  const db = getDb(c.env);
  const row = await db
    .select({ role: schema.users.role })
    .from(schema.users)
    .where(eq(schema.users.uid, user.uid))
    .get();
  return row?.role === "admin";
}

// NOTE: there is deliberately no `requireAdmin` middleware here.
//
// `/admin/*` has its own gate in routes/admin.ts, which additionally supports
// the X-Admin-Secret server-to-server path and resolves granular roles
// (superadmin / admin / moderator). A second, weaker admin middleware existed
// here with zero callers and — unlike everything above — never called
// assertAccountNotBlocked, so a blocked admin would still have passed it. It was
// removed rather than fixed to keep one authorization path.
//
// For per-action admin checks inside /api, use the `isAdmin()` helper above on
// top of `requireAuth`.
