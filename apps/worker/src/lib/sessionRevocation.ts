/**
 * Ending sessions that are already signed in.
 *
 * ---------------------------------------------------------------------------
 * The gap this closes
 * ---------------------------------------------------------------------------
 * Authentication here is stateless: an ID token arrives as a bearer token and
 * `verifyIdToken` checks its signature against locally cached JWKS. That is fast and
 * correct, and it has one consequence — there is no point at which Firebase gets
 * asked "is this session still supposed to exist?". Nothing in this codebase called
 * `revokeRefreshTokens` either. So until now:
 *
 *   * changing your password left every other device signed in;
 *   * a stolen refresh token was good forever, minting fresh ID tokens indefinitely;
 *   * recovering an account by phone OTP restored the owner's access without evicting
 *     whoever was already inside;
 *   * and there was no "log out everywhere" for a user to reach for at all — the only
 *     kill switch was an admin blocking the entire account.
 *
 * ---------------------------------------------------------------------------
 * How it works
 * ---------------------------------------------------------------------------
 * One timestamp per user: `users.tokens_valid_after`. A token is refused when its
 * `auth_time` claim is older than that cutoff.
 *
 * `auth_time` is the right claim and `iat` is not. The SDK refreshes ID tokens roughly
 * hourly and `iat` moves with every refresh, so a cutoff compared against `iat` would
 * be satisfied again within the hour and revocation would silently expire.
 * `auth_time` only moves when a human actually authenticates — which is exactly the
 * event that should be able to get back in, and the one thing an attacker holding a
 * token cannot manufacture. It is the same claim `lib/reauth.ts` relies on for the
 * "prove it's still you" gate, for the same reason.
 *
 * Everything is in EPOCH SECONDS. See migration 0044: `auth_time` is a whole-second
 * claim, and a millisecond cutoff compared against it rejects a legitimate brand-new
 * session up to a second after the user signs back in. Seconds is also what Firebase's
 * `validSince` takes, so one value drives both sides.
 *
 * ---------------------------------------------------------------------------
 * The one-second window, stated rather than left to be rediscovered
 * ---------------------------------------------------------------------------
 * Because both sides are floored to a second and the comparison is inclusive, a session
 * that authenticated in the SAME second as a revocation survives it. The trade is
 * deliberate and it is not symmetric: making the comparison exclusive would close that
 * sub-second hole and, in exchange, refuse the user's own brand-new session whenever they
 * sign back in during the same second they revoked — a visible, repeatable lockout traded
 * for a window an attacker cannot aim at.
 */
import { eq, sql } from "drizzle-orm";
import type { AuthUser, Env } from "../types";
import { getDb, schema } from "../db";
import { revokeRefreshTokens } from "./firebaseAdmin";
import { closeRealtimeSessions } from "./publish";
import { httpsError } from "./http";
import { invalidateAuthState } from "./cache";

/**
 * Marker the client matches on to tell a revoked session from an expired one.
 *
 * Embedded in the MESSAGE rather than carried as its own error code, following
 * `REAUTH_REQUIRED_CODE` in lib/reauth.ts. The reason is the same: the HTTP status has
 * to stay the one the client already handles correctly — 401 here, so the existing
 * sign-out path in `apps/expo/src/services/api.ts` runs — while still letting the app
 * say something more useful than "your session expired".
 *
 * The distinction matters to the user. "Expired" invites them to sign in again and
 * carry on. "Signed out for security" tells them something happened to their account,
 * which is the difference between noticing a takeover and shrugging at a glitch.
 */
export const SESSION_REVOKED_CODE = "session_revoked";

/** Why sessions were ended. Recorded in logs; never returned to the caller. */
export type RevocationReason =
  | "password_changed"
  | "password_reset"
  | "email_changed"
  | "phone_changed"
  | "user_logout_all"
  | "admin_forced"
  | "admin_blocked";

const nowSec = (): number => Math.floor(Date.now() / 1000);

/**
 * Refuse a token that was issued to a session the account has since ended.
 *
 * Pure and synchronous: the cutoff is read as part of the account lookup the auth
 * middleware already performs, so enforcing this costs no additional query on the hot
 * path.
 *
 * A MISSING `auth_time` is treated as revoked whenever a cutoff exists, which is the
 * fail-closed direction and matches `hasFreshSession`'s reasoning: the claim is
 * standard on Firebase ID tokens, so its absence means something is unusual, and
 * "unusual" must not be the case that slips past the check. If we cannot prove a
 * session started after the cutoff, we cannot honour the revocation — and honouring it
 * is the entire point.
 */
export function assertSessionNotRevoked(
  user: Pick<AuthUser, "authTime">,
  tokensValidAfter: number | null | undefined,
): void {
  if (!tokensValidAfter) return;

  const authTime = user.authTime;
  const proven = typeof authTime === "number" && Number.isFinite(authTime);
  if (proven && authTime >= tokensValidAfter) return;

  throw httpsError(
    "unauthenticated",
    `${SESSION_REVOKED_CODE}: You were signed out for security. Please sign in again.`,
  );
}

/**
 * Write the cutoff. Returns false when the account does not exist.
 *
 * Never lowers an existing cutoff: two revocations racing must not let the earlier one
 * undo the later one, and `MAX` in SQL keeps that true without a read-modify-write.
 */
async function setCutoff(
  env: Env,
  uid: string,
  cutoffSec: number,
  options: { clearPushTokens?: boolean } = {},
): Promise<boolean> {
  const res = await getDb(env)
    .update(schema.users)
    .set({
      // `MAX(COALESCE(col, 0), value)` rather than a plain assignment: monotonic, so
      // the cutoff can only ever move forward. Done in SQL rather than as a
      // read-modify-write so two concurrent revocations cannot interleave such that
      // the earlier one lands last and undoes the later one.
      tokensValidAfter: sql`MAX(COALESCE(${schema.users.tokensValidAfter}, 0), ${cutoffSec})`,
      // Every other writer of `fcmTokens` bumps this, and the row has genuinely changed.
      updatedAt: Date.now(),
      /**
       * Drop every push token when EVERY session is being ended.
       *
       * A device that has been signed out must stop receiving the account's
       * notifications, and a revoked session does not detach its own token — it cannot,
       * because the call that would do so is authenticated and it no longer has a
       * working session. Leaving them in place means "log out of all devices" silently
       * keeps delivering contest results, wallet activity and message previews to
       * exactly the devices the user was trying to cut off, which is the same complaint
       * the sign-out path already documents for resold handsets.
       *
       * Only on a FULL revocation. `revokeOtherSessions` keeps the caller signed in, and
       * this column is not per-device, so clearing it there would silence the
       * notifications of the one device that is meant to survive.
       */
      ...(options.clearPushTokens ? { fcmTokens: [] } : {}),
    })
    .where(eq(schema.users.uid, uid))
    .run();
  const changed = Number(res.meta?.changes || 0) > 0;
  // `tokensValidAfter` just moved, so any cached auth-state (paid tier only) is now
  // stale — drop it in every colo so the new cutoff takes effect immediately rather
  // than after the cache TTL. No-op cost on free, where nothing is cached.
  if (changed) await invalidateAuthState(env, uid);
  return changed;
}

/**
 * End EVERY session on the account, including the one making the request.
 *
 * For the cases where the account itself is in question: the user believes someone
 * else is inside it, an admin is intervening, or access was just recovered through a
 * signed-out flow. There is no session worth preserving in any of those, and
 * preserving one would mean deciding which — a judgement this function has no basis to
 * make.
 *
 * Firebase's `validSince` is set as well, which invalidates the REFRESH tokens. That is
 * what stops a client simply minting a new ID token and carrying on; the D1 cutoff
 * alone would refuse the token at our API while leaving the Firebase session alive. The
 * Firebase call is best-effort: the D1 cutoff is what this API enforces, and it has
 * already been written by the time we get here, so a Firebase blip must not report a
 * completed revocation as failed.
 */
export async function revokeAllSessions(
  env: Env,
  uid: string,
  reason: RevocationReason,
): Promise<void> {
  const cutoff = nowSec();
  const existed = await setCutoff(env, uid, cutoff, { clearPushTokens: true });
  if (!existed) return;

  console.log("[sessionRevocation] all sessions ended", { uid, reason, cutoff });

  // try/catch rather than `.catch()`, and the difference is not stylistic: `.catch()`
  // only handles a REJECTED promise, so anything the call throws synchronously — before
  // it returns a promise at all — would escape and fail the request. This block's
  // contract is that nothing here can do that, since the cutoff above has already
  // committed and is what this API actually enforces.
  //
  // Not fatal, but logged at error level: what a failure leaves behind is a live
  // refresh token, which is a real loose end rather than a cosmetic one.
  try {
    await revokeRefreshTokens(env, uid, cutoff);
  } catch (e) {
    console.error("[sessionRevocation] Firebase refresh-token revoke failed", { uid, reason }, e);
  }

  /**
   * Close any socket that is already open.
   *
   * A WebSocket is authorised ONCE, at the upgrade, so the cutoff above does not reach a
   * connection that already exists — it keeps delivering notifications and chat messages
   * for as long as the client's heartbeat holds it open. Ending every session while
   * leaving a live read feed to the device you were trying to cut off is not the promise
   * this function makes.
   *
   * Belongs HERE rather than at each call site: it was previously only wired into the two
   * admin paths, so the user's own "log out of all devices" — the one case where the
   * person asking is worried about someone watching — was the one that left the sockets
   * up. Doing it inside the revocation means no future caller can forget.
   *
   * Already best-effort internally; nothing here can fail the request.
   */
  await closeRealtimeSessions(env, uid);
}

/**
 * End every session EXCEPT the caller's.
 *
 * For a routine credential change made by someone who is demonstrably already in
 * control: they reauthenticated moments ago, and signing them out of the device they
 * are holding is a worse experience than the change is worth. Every other device — the
 * one left at a friend's house, the one the password was changed because of — is
 * ended.
 *
 * The caller is preserved by using THEIR OWN `auth_time` as the cutoff rather than the
 * current time, so every session that authenticated strictly earlier is refused and
 * theirs is not. Two consequences worth stating:
 *
 *   * A device that signed in LATER than the caller survives. That is inherent to a
 *     single-timestamp scheme, and it is why this is not offered as the answer to "my
 *     account is compromised" — `revokeAllSessions` is.
 *   * Firebase's `validSince` is NOT set here. It would invalidate the caller's own
 *     refresh token along with everyone else's, logging out the very device this
 *     function exists to keep signed in. The D1 cutoff is enough for our surface: other
 *     devices can still refresh, but every token they mint carries the old `auth_time`
 *     and is refused on arrival, so the app is unusable for them.
 *
 * Falls back to ending ALL sessions when the caller's `auth_time` is unknown. Without
 * it there is no way to identify which session to keep, and guessing in the permissive
 * direction would mean a credential change that revoked nothing at all.
 */
export async function revokeOtherSessions(
  env: Env,
  user: AuthUser,
  reason: RevocationReason,
): Promise<void> {
  const authTime = user.authTime;
  if (typeof authTime !== "number" || !Number.isFinite(authTime)) {
    console.warn(
      "[sessionRevocation] no auth_time on the caller's token — ending all sessions instead",
      { uid: user.uid, reason },
    );
    await revokeAllSessions(env, user.uid, reason);
    return;
  }

  /**
   * Clamped to now, never trusted forward.
   *
   * `setCutoff` is monotonic and nothing in this codebase can lower a cutoff, so a
   * future-dated value is not a transient glitch — it locks the account out of its own
   * API until real time catches up, and the only repair is hand-written SQL against
   * production. `hasFreshSession` already treats a future-dated `auth_time` as a real
   * possibility ("a clock-skewed token must not buy unlimited freshness"); the same
   * caution belongs here, where the consequence is durable rather than momentary.
   */
  const cutoff = Math.min(authTime, nowSec());

  const existed = await setCutoff(env, user.uid, cutoff);
  if (!existed) return;
  console.log("[sessionRevocation] other sessions ended", { uid: user.uid, reason, cutoff });
}
