import { eq } from "drizzle-orm";
import type { Env } from "../types";
import { getDb, schema } from "../db";
import { httpsError } from "./http";
import { newId, now } from "./ids";

/**
 * Shared admin authority + audit helpers.
 *
 * `/admin/*` has its own gate with a granular role matrix, but a handful of
 * admin-power actions also live inside `/api` (they predate the /admin router).
 * Those used to accept a plain `isAdmin()` check — weaker than the /admin gate
 * and with no audit trail — which meant the SAME capability had two different
 * authority levels depending on which URL you called. These helpers give the
 * /api actions identical authority and identical auditing.
 */

/** Roles allowed to move money, change roles, or alter user lifecycle. */
export const FULL_ADMIN_ROLES = ["superadmin", "admin"] as const;

export async function getUserRole(env: Env, uid: string): Promise<string | null> {
  const row = await getDb(env)
    .select({ role: schema.users.role })
    .from(schema.users)
    .where(eq(schema.users.uid, uid))
    .get();
  return row?.role ?? null;
}

/**
 * Require a full admin (superadmin or admin) for an /api action.
 * Moderators are content-moderation only and are rejected here.
 */
export async function requireFullAdmin(env: Env, uid: string | undefined | null): Promise<string> {
  if (!uid) throw httpsError("unauthenticated", "User must be logged in.");
  const role = await getUserRole(env, uid);
  if (!role || !(FULL_ADMIN_ROLES as readonly string[]).includes(role)) {
    throw httpsError("permission-denied", "This action requires a full administrator.");
  }
  return role;
}

export interface AuditActor {
  uid?: string | null;
  email?: string | null;
}

/**
 * Record a sensitive admin action. Best-effort: a failed audit write must never
 * break the action it describes, but it is always logged.
 */
export async function writeAdminAudit(
  env: Env,
  actor: AuditActor | null | undefined,
  action: string,
  targetType: string,
  targetId: string | null,
  detail?: Record<string, unknown>,
): Promise<void> {
  try {
    await getDb(env).insert(schema.adminAuditLog).values({
      id: newId(),
      adminUid: actor?.uid ?? null,
      adminEmail: actor?.email ?? (actor ? null : "server"),
      action,
      targetType,
      targetId: targetId ?? null,
      detail: detail ?? null,
      createdAt: now(),
    });
  } catch (e) {
    console.error("[audit] failed to record", action, e);
  }
}
