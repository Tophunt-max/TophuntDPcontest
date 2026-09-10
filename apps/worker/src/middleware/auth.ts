import { createMiddleware } from "hono/factory";
import { eq } from "drizzle-orm";
import type { AuthUser, Env, Variables } from "../types";
import { verifyIdToken, bearerToken } from "../lib/firebaseAuth";
import { assertSessionNotRevoked } from "../lib/sessionRevocation";
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
  /** Epoch SECONDS. Sessions older than this are revoked. See lib/sessionRevocation.ts. */
  tokensValidAfter: number | null;
}

function readAccountState(env: Env, uid: string): Promise<AccountState | undefined> {
  return getDb(env)
    .select({
      status: schema.users.status,
      isBlocked: schema.users.isBlocked,
      // Selected here rather than in its own lookup so enforcing revocation costs
      // ZERO extra queries — this row is already read on every authenticated request.
      tokensValidAfter: schema.users.tokensValidAfter,
    })
    .from(schema.users)
    .where(eq(schema.users.uid, uid))
    .get() as Promise<AccountState | undefined>;
}

/** The moderation half of the gate, split out so both entry points share one copy. */
function assertNotBlocked(account: AccountState | undefined): void {
  if (account?.status === DELETED_STATUS) {
    throw httpsError("permission-denied", "This account has been deleted.");
  }
  if (account?.isBlocked || account?.status === BLOCKED_STATUS) {
    throw httpsError("permission-denied", "This account has been blocked.");
  }
}

/**
 * Reject a token that D1 says should no longer work — for either reason.
 *
 * Takes the whole `user` rather than a uid, and checks BOTH revocation and
 * moderation, deliberately. The two are independent facts about an account and the
 * checks are trivially separable, which is exactly why they are not separated: a caller
 * that verified a token and asked only "is this account blocked?" would happily accept
 * a session the user had explicitly ended. Both callers outside this file — the admin
 * gate and the `/ws` upgrade — are places where that would matter, and the `/ws` one
 * especially: a revoked session must not be able to hold open a realtime socket.
 *
 * Firebase ID tokens stay verifiable for up to an hour after either fact changes,
 * because `verifyIdToken` checks a signature against cached JWKS and never asks
 * Firebase anything. D1 is therefore the source of truth for anything that has to take
 * effect NOW.
 */
export async function assertSessionUsable(env: Env, user: AuthUser): Promise<void> {
  const account = await readAccountState(env, user.uid);
  // Moderation FIRST. Both refusals are correct here, but only one of them is true about
  // the account rather than the session — and a blocked user told "you were signed out
  // for security" is being handed a security scare in place of a moderation decision.
  assertNotBlocked(account);
  assertSessionNotRevoked(user, account?.tokensValidAfter);
}

/** Require a valid Firebase ID token, and a session that is still supposed to exist. */
export const requireAuth = createMiddleware<MW>(async (c, next) => {
  const token = bearerToken(c.req.header("Authorization"));
  if (!token) throw httpsError("unauthenticated", "User must be logged in.");
  const user = await verifyIdToken(token, c.env);

  await assertSessionUsable(c.env, user);

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

  const blocked = account?.isBlocked || account?.status === BLOCKED_STATUS;
  const selfService = SELF_SERVICE_ACTIONS.has(action);

  // Anonymised is terminal. No action, self-service or otherwise, gets back in —
  // there is no longer an account to act on, and `deleteAccount` in particular
  // must not restart a purge that has already completed.
  if (account?.status === DELETED_STATUS) {
    throw httpsError("permission-denied", "This account has been deleted.");
  }

  // Moderation is checked BEFORE revocation. Blocking an account also revokes its
  // sessions now, so both refusals apply at once — and only one of them is a true
  // statement about the account rather than about the session. Announcing a moderation
  // decision as "you were signed out for security" would hand the user a security scare
  // in place of the reason they were actually stopped.
  if (!selfService && blocked) {
    throw httpsError("permission-denied", "This account has been blocked.");
  }

  /**
   * A revoked session is not a session, so no action gets an exemption from this — with
   * ONE carve-out, and it is a compliance requirement rather than a convenience.
   *
   * The rule first. Someone whose session was explicitly ended is not entitled to it, so
   * letting a revoked token reach `deleteAccount` would hand the one irreversible action
   * to precisely the session the owner was trying to shut out. That is why this sits
   * outside the action-specific branching.
   *
   * The carve-out. Blocking an account revokes its sessions, which is right — otherwise
   * unblocking restored the intruder along with the user. But `isBlocked` is also the
   * exact state `SELF_SERVICE_ACTIONS` exists for: "both app stores require an in-app way
   * to delete an account, and the auth middleware rejected every request from a blocked
   * account before the router ever saw the action name". Without this branch, blocking an
   * account would silently close the deletion path again — reintroducing the compliance
   * hole that list was written to close, by a longer route.
   *
   * It grants nothing extra. A blocked account has already been refused everything else
   * above, and every self-service action operates on the caller's own account. A user who
   * revoked their OWN sessions and is not blocked gets no exemption at all.
   */
  if (!(blocked && selfService)) {
    assertSessionNotRevoked(user, account?.tokensValidAfter);
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

/**
 * Attach user if a token is present, but don't require it (guest routes).
 *
 * A revoked session is swallowed along with every other failure and the request
 * continues as a GUEST, which is the right outcome rather than a leniency: these are
 * public routes, so the caller still gets the public answer — they simply stop being
 * recognised. That is what being signed out means. It also keeps a revoked token from
 * quietly retaining viewer-specific treatment, like seeing a profile it had been
 * allowed to see.
 *
 * KNOWN CONSEQUENCE, on `/auth`. That route mounts this middleware because most of its
 * actions run before sign-in, but a few (the email/phone change handlers) do require a
 * session and answer "User must be logged in." when the identity is missing. A revoked
 * token therefore gets an UNMARKED 401 there, so the app says "your session expired"
 * instead of "signed out for security" for that one request. Accepted rather than fixed:
 * surfacing the reason means threading it out of a middleware whose entire contract is to
 * discard failures, and the mismatch corrects itself on the next `/api` call — which the
 * app makes constantly, and which reports revocation properly. Pinned in
 * test/reauth.test.ts so it stays a decision.
 */
export const optionalAuth = createMiddleware<MW>(async (c, next) => {
  const token = bearerToken(c.req.header("Authorization"));
  if (token) {
    try {
      const user = await verifyIdToken(token, c.env);
      await assertSessionUsable(c.env, user);
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
