import { createMiddleware } from "hono/factory";
import { eq } from "drizzle-orm";
import type { Env, Variables } from "../types";
import { verifyIdToken, bearerToken } from "../lib/firebaseAuth";
import { httpsError } from "../lib/http";
import { getDb, schema } from "../db";

type MW = { Bindings: Env; Variables: Variables };

/** Require a valid Firebase ID token; sets c.var.user. */
export const requireAuth = createMiddleware<MW>(async (c, next) => {
  const token = bearerToken(c.req.header("Authorization"));
  if (!token) throw httpsError("unauthenticated", "User must be logged in.");
  const user = await verifyIdToken(token, c.env);
  c.set("user", user);
  await next();
});

/** Attach user if a token is present, but don't require it (guest routes). */
export const optionalAuth = createMiddleware<MW>(async (c, next) => {
  const token = bearerToken(c.req.header("Authorization"));
  if (token) {
    try {
      c.set("user", await verifyIdToken(token, c.env));
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

/** Require an authenticated admin. */
export const requireAdmin = createMiddleware<MW>(async (c, next) => {
  const token = bearerToken(c.req.header("Authorization"));
  if (!token) throw httpsError("unauthenticated", "User must be logged in.");
  c.set("user", await verifyIdToken(token, c.env));
  if (!(await isAdmin(c as any))) throw httpsError("permission-denied", "Admin only.");
  await next();
});
