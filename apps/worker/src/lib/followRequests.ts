/**
 * Follow requests (migration 0057) — the write side of private accounts.
 *
 * Lifecycle:
 *   follow a private account  → a `follow_requests` row + a `follow_request`
 *                               notification to the owner;
 *   tap again ("Requested")   → cancels the request;
 *   owner confirms            → the row moves into `follows`, counters bump, the
 *                               requester gets `follow_accept`;
 *   owner deletes             → the row goes, nobody is told (Instagram semantics);
 *   account switches public   → every pending request is approved at once;
 *   block / account deletion  → requests in both directions are removed.
 *
 * Every write that moves a request into `follows` is ONE D1 batch whose
 * statements are gated on the request row still existing and the follow edge
 * not existing yet, and the gated updates run BEFORE the delete that removes the
 * request. D1 batches are serial transactions, so a double-tapped Confirm, or a
 * Confirm racing a cancel, can neither double-count nor create an edge for a
 * request that was already withdrawn.
 */
import { and, eq } from "drizzle-orm";
import type { Env } from "../types";
import { getDb, schema } from "../db";

const REQUEST_EXISTS = `EXISTS (SELECT 1 FROM follow_requests WHERE requester_id = ? AND target_id = ?)`;
const EDGE_ABSENT = `NOT EXISTS (SELECT 1 FROM follows WHERE follower_id = ? AND following_id = ?)`;

/** Does `requester` have a pending request to `target`? */
export async function hasPendingRequest(env: Env, requester: string, target: string): Promise<boolean> {
  const row = await getDb(env)
    .select({ r: schema.followRequests.requesterId })
    .from(schema.followRequests)
    .where(and(eq(schema.followRequests.requesterId, requester), eq(schema.followRequests.targetId, target)))
    .get();
  return !!row;
}

/** Statements removing the owner's `follow_request` notification(s) from `requester` (or from everyone). */
function requestNotificationDelete(env: Env, target: string, requester?: string) {
  return requester
    ? env.DB.prepare(
        `DELETE FROM notifications WHERE recipient_id = ? AND type = 'follow_request' AND actor_id = ?`,
      ).bind(target, requester)
    : env.DB.prepare(`DELETE FROM notifications WHERE recipient_id = ? AND type = 'follow_request'`).bind(target);
}

/**
 * Confirm one request. Returns true when a request existed and was turned into
 * a follow, false when there was nothing to confirm (already handled, cancelled).
 */
export async function approveFollowRequest(env: Env, requester: string, target: string, ts: number): Promise<boolean> {
  if (!(await hasPendingRequest(env, requester, target))) return false;
  const gate = `${REQUEST_EXISTS} AND ${EDGE_ABSENT}`;
  const gateBinds = [requester, target, requester, target];
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE users SET following_count = COALESCE(following_count, 0) + 1 WHERE uid = ? AND ${gate}`,
    ).bind(requester, ...gateBinds),
    env.DB.prepare(
      `UPDATE users SET followers_count = COALESCE(followers_count, 0) + 1 WHERE uid = ? AND ${gate}`,
    ).bind(target, ...gateBinds),
    env.DB.prepare(
      `INSERT OR IGNORE INTO follows (follower_id, following_id, created_at) SELECT ?, ?, ? WHERE ${REQUEST_EXISTS}`,
    ).bind(requester, target, ts, requester, target),
    env.DB.prepare(`DELETE FROM follow_requests WHERE requester_id = ? AND target_id = ?`).bind(requester, target),
    requestNotificationDelete(env, target, requester),
  ]);
  return true;
}

/** Delete (reject) or cancel one request. Idempotent. */
export async function deleteFollowRequest(env: Env, requester: string, target: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM follow_requests WHERE requester_id = ? AND target_id = ?`).bind(requester, target),
    requestNotificationDelete(env, target, requester),
  ]);
}

/**
 * Approve EVERY pending request to `target` — run when the account goes public,
 * which is what Instagram does. Returns the requester uids that became followers
 * (for cache purges). Requesters that already follow are not double-counted.
 */
export async function approveAllFollowRequests(env: Env, target: string, ts: number): Promise<string[]> {
  const pending = await getDb(env)
    .select({ uid: schema.followRequests.requesterId })
    .from(schema.followRequests)
    .where(eq(schema.followRequests.targetId, target))
    .all();
  if (!pending.length) return [];
  const newEdge = `NOT EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = fr.requester_id AND f.following_id = fr.target_id)`;
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE users SET following_count = COALESCE(following_count, 0) + 1
        WHERE uid IN (SELECT fr.requester_id FROM follow_requests fr WHERE fr.target_id = ? AND ${newEdge})`,
    ).bind(target),
    env.DB.prepare(
      `UPDATE users SET followers_count = COALESCE(followers_count, 0) +
         (SELECT COUNT(*) FROM follow_requests fr WHERE fr.target_id = ? AND ${newEdge})
        WHERE uid = ?`,
    ).bind(target, target),
    env.DB.prepare(
      `INSERT OR IGNORE INTO follows (follower_id, following_id, created_at)
       SELECT requester_id, target_id, ? FROM follow_requests WHERE target_id = ?`,
    ).bind(ts, target),
    env.DB.prepare(`DELETE FROM follow_requests WHERE target_id = ?`).bind(target),
    requestNotificationDelete(env, target),
  ]);
  return pending.map((p) => p.uid);
}

/** Statements removing requests in BOTH directions between two accounts (block path). */
export function deleteRequestsBetweenStmts(db: ReturnType<typeof getDb>, a: string, b: string) {
  const fr = schema.followRequests;
  const n = schema.notifications;
  const requestNote = (target: string, requester: string) =>
    db.delete(n).where(and(eq(n.recipientId, target), eq(n.type, "follow_request"), eq(n.actorId, requester)));
  return [
    db.delete(fr).where(and(eq(fr.requesterId, a), eq(fr.targetId, b))),
    db.delete(fr).where(and(eq(fr.requesterId, b), eq(fr.targetId, a))),
    // And their "wants to follow you" rows, as every other request-removal path
    // does. After a block the row stayed in the inbox with a Confirm that the
    // block then refused, so it could never be answered or cleared.
    requestNote(b, a),
    requestNote(a, b),
  ];
}
