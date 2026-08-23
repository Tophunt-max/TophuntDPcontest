import { createMiddleware } from "hono/factory";
import { eq } from "drizzle-orm";
import type { Env, Variables } from "../types";
import { verifyIdToken, bearerToken } from "../lib/firebaseAuth";
import { httpsError } from "../lib/http";
import { getDb, schema } from "../db";

type MW = { Bindings: Env; Variables: Variables };

/** Reject an already-issued token as soon as its D1 account is blocked. */
export async function assertAccountNotBlocked(env: Env, uid: string): Promise<void> {
  const account = await getDb(env)
    .select({ status: schema.users.status, isBlocked: schema.users.isBlocked })
    .from(schema.users)
    .where(eq(schema.users.uid, uid))
    .get();
  if (account?.isBlocked || account?.status === "blocked") {
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
