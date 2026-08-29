import { httpsError } from "./http";

const CONTEST_TYPES = ["photo", "video"] as const;
const CONTEST_STATUSES = ["live", "upcoming", "paused", "ended"] as const;
const CONTEST_CANONICAL_EXTRA_KEYS = [
  "id",
  "title",
  "name",
  "type",
  "status",
  "bannerUrl",
  "bannerImageUrl",
  "totalEntryFee",
  "entryFishCoins",
  "entryDpcoin",
  "rewardCoins",
  "prizePool",
  "winningCoins",
  "voteDurationDays",
  "durationHours",
  "autoCancelHours",
  "minVotes",
  "createdBy",
  "createdAt",
  // Validity window and every alias it is accepted under. These are physical
  // columns now, so a copy left behind in `extra` would be a second, silently
  // stale source of truth for the same value.
  "startsAt",
  "startAt",
  "startDate",
  "endsAt",
  "endAt",
  "endDate",
  "validUntil",
  "expiresAt",
  "totalMatches",
  "waitingMatches",
  "activeMatches",
] as const;

export const hasOwn = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
export const isRecord = (value: unknown): value is Record<string, any> =>
  !!value && typeof value === "object" && !Array.isArray(value);

function firstAlias(body: Record<string, any>, aliases: string[]): { present: boolean; value?: any } {
  for (const aliasName of aliases) {
    if (hasOwn(body, aliasName)) return { present: true, value: body[aliasName] };
  }
  return { present: false };
}

function contestInteger(value: unknown, field: string, min: number, max: number): number {
  if (typeof value === "boolean" || value === null || (typeof value === "string" && !value.trim())) {
    throw httpsError("invalid-argument", `${field} must be an integer between ${min} and ${max}.`);
  }
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw httpsError("invalid-argument", `${field} must be an integer between ${min} and ${max}.`);
  }
  return parsed;
}

function contestText(value: unknown, field: string, maxLength: number): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > maxLength) {
    throw httpsError("invalid-argument", `${field} must be a string of at most ${maxLength} characters.`);
  }
  return value;
}

/**
 * A validity-window bound, normalised to epoch milliseconds.
 *
 * `null` / `""` mean "unbounded" and are preserved as null rather than coerced
 * to 0 — `new Date("")` is Invalid Date and `Number(null)` is 0, and either
 * silently turns "no expiry" into "expired in 1970", which would hide every
 * contest it was applied to.
 *
 * Accepts an epoch-ms number (what our own admin panel and app send back), a
 * numeric string, or an ISO-8601 string (what a hand-written curl or the seed
 * scripts are most likely to send).
 *
 * A string form WITHOUT an explicit offset — "2026-09-01T18:30" or
 * "2026-09-01" — resolves against the Worker's timezone, which is UTC. That is
 * not the same as the identical text typed into the admin panel, where it means
 * the admin's local time. Send epoch ms, or include an offset ("...+05:30"), if
 * the distinction matters.
 */
function contestTimestamp(value: unknown, field: string): number | null {
  if (value === null || value === undefined || (typeof value === "string" && !value.trim())) return null;
  if (typeof value === "boolean") {
    throw httpsError("invalid-argument", `${field} must be null, epoch milliseconds, or an ISO-8601 date string.`);
  }

  let ms: number;
  if (typeof value === "number") {
    ms = value;
  } else if (typeof value === "string") {
    const trimmed = value.trim();
    // A bare integer string is epoch ms; anything else goes through Date so
    // "2026-09-01T18:30:00.000Z" and "2026-09-01" both work.
    ms = /^-?\d+$/.test(trimmed) ? Number(trimmed) : new Date(trimmed).getTime();
  } else {
    throw httpsError("invalid-argument", `${field} must be null, epoch milliseconds, or an ISO-8601 date string.`);
  }

  if (!Number.isFinite(ms) || !Number.isInteger(ms)) {
    throw httpsError("invalid-argument", `${field} must be null, epoch milliseconds, or an ISO-8601 date string.`);
  }
  // Reject seconds-based timestamps outright. A caller sending 1788000000 means
  // 2026, but as milliseconds it is 1970 — so it would be accepted, stored, and
  // instantly expire the contest. The floor is 2001-09-09, comfortably below any
  // date this product can be configured with and far above any plausible
  // seconds value.
  if (ms < 1_000_000_000_000) {
    throw httpsError(
      "invalid-argument",
      `${field} must be in epoch MILLISECONDS (got ${ms}, which is before 2001 — seconds were probably sent).`,
    );
  }
  // ~year 10000. Guards against overflow nonsense being stored forever.
  if (ms > 253_402_300_799_000) {
    throw httpsError("invalid-argument", `${field} is too far in the future.`);
  }
  return ms;
}

/**
 * The window must be orderable and must leave the contest some life.
 *
 * Called with the MERGED values on PATCH, exactly like assertPrizeFundedByPot:
 * a patch that only moves `startsAt` past an untouched `endsAt` is just as
 * broken as one that sets both the wrong way round, and the validator only ever
 * sees the request body.
 */
export function assertContestWindow(
  startsAt: number | null,
  endsAt: number | null,
  opts: { requireFuture?: boolean } = {},
): void {
  if (startsAt !== null && endsAt !== null && endsAt <= startsAt) {
    throw httpsError("invalid-argument", "The contest end time must be after its start time.");
  }
  // Only enforced on create. An admin ending a running contest early sets
  // endsAt to a moment that may already have passed by the time the request
  // lands, and that is a legitimate "close this now" — but a contest CREATED
  // already expired is always a mistake, and one that is invisible afterwards
  // because the app never lists it.
  if (opts.requireFuture && endsAt !== null && endsAt <= Date.now()) {
    throw httpsError("invalid-argument", "The contest end time must be in the future.");
  }
}

/**
 * Refuse to take a player's coins for a contest that is outside its validity
 * window.
 *
 * `GET /read/contests` hiding an out-of-window contest is presentation, not
 * enforcement: the detail endpoint does not filter, a list response is cached
 * for 60s, and a screen fetched before the deadline can submit after it. Without
 * this the window would only be a suggestion, and the two flows that debit an
 * entry fee — `startMatch` and `joinMatch` — would happily charge for a contest
 * that has closed, or one scheduled to open next week that was saved as `live`
 * up front (which is exactly the workflow the admin panel recommends).
 *
 * `status === 'live'` is checked separately by both callers and is deliberately
 * left there: it is a different question, and the cron only reconciles it to the
 * window every 10 minutes.
 */
export function assertContestOpenNow(
  contest: { startsAt?: number | null; endsAt?: number | null },
  action: "new matches" | "opponents",
): void {
  const nowMs = Date.now();
  const startsAt = contest.startsAt ?? null;
  const endsAt = contest.endsAt ?? null;
  if (startsAt !== null && startsAt > nowMs) {
    throw httpsError("failed-precondition", `This contest has not opened yet, so it is not accepting ${action}.`);
  }
  if (endsAt !== null && endsAt <= nowMs) {
    throw httpsError("failed-precondition", `This contest has closed, so it is no longer accepting ${action}.`);
  }
}

export function contestBannerUrl(value: unknown): string | null {
  if (value === null || value === "") return null;
  if (typeof value !== "string") {
    throw httpsError("invalid-argument", "bannerUrl must be null or a valid HTTP(S) URL.");
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 2048) {
    throw httpsError("invalid-argument", "bannerUrl must be null or a valid HTTP(S) URL up to 2048 characters.");
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("invalid protocol");
  } catch {
    throw httpsError("invalid-argument", "bannerUrl must be null or a valid HTTP(S) URL.");
  }
  return trimmed;
}

/** Shared parser for every server-side admin contest create/PATCH path. */
export function validateContestInput(
  body: unknown,
  creating: boolean,
): { recognized: boolean; values: Record<string, any> } {
  if (!isRecord(body)) throw httpsError("invalid-argument", "A JSON object is required.");
  const values: Record<string, any> = {};
  let recognized = false;

  const title = firstAlias(body, ["title", "name"]);
  if (title.present || creating) {
    recognized ||= title.present;
    if (typeof title.value !== "string") throw httpsError("invalid-argument", "title is required.");
    const trimmed = title.value.trim();
    if (!trimmed || trimmed.length > 160) {
      throw httpsError("invalid-argument", "title is required and must be at most 160 characters.");
    }
    values.title = trimmed;
  }

  const type = firstAlias(body, ["type"]);
  if (type.present || creating) {
    recognized ||= type.present;
    const value = type.present ? type.value : "photo";
    if (!CONTEST_TYPES.includes(value)) throw httpsError("invalid-argument", "type must be photo or video.");
    values.type = value;
  }

  const status = firstAlias(body, ["status"]);
  if (status.present || creating) {
    recognized ||= status.present;
    const value = status.present ? status.value : "upcoming";
    if (!CONTEST_STATUSES.includes(value)) {
      throw httpsError("invalid-argument", "status must be live, upcoming, paused, or ended.");
    }
    values.status = value;
  }

  const fee = firstAlias(body, ["totalEntryFee", "entryFishCoins", "entryDpcoin"]);
  if (fee.present || creating) {
    recognized ||= fee.present;
    const total = contestInteger(fee.present ? fee.value : 0, "totalEntryFee", 0, 1_000_000);
    // Two players each pay half. An odd total would charge a fractional number
    // of coins, and fractions in a whole-number currency accumulate float drift
    // that makes the ledger impossible to reconcile against balances.
    if (total % 2 !== 0) {
      throw httpsError(
        "invalid-argument",
        `totalEntryFee must be an even number of coins — each of the two players pays half (got ${total}).`,
      );
    }
    values.totalEntryFee = total;
  }

  const reward = firstAlias(body, ["rewardCoins", "prizePool", "winningCoins"]);
  if (reward.present || creating) {
    recognized ||= reward.present;
    values.rewardCoins = contestInteger(reward.present ? reward.value : 0, "rewardCoins", 0, 10_000_000);
  }

  const durationDays = firstAlias(body, ["voteDurationDays"]);
  const durationHours = firstAlias(body, ["durationHours"]);
  if (durationDays.present || durationHours.present || creating) {
    recognized ||= durationDays.present || durationHours.present;
    let rawDuration: unknown = 1;
    if (durationDays.present) {
      rawDuration = durationDays.value;
    } else if (durationHours.present) {
      if (
        typeof durationHours.value === "boolean" ||
        durationHours.value === null ||
        (typeof durationHours.value === "string" && !durationHours.value.trim())
      ) {
        throw httpsError("invalid-argument", "durationHours must represent 1 to 30 days.");
      }
      const hours = Number(durationHours.value);
      if (!Number.isFinite(hours) || hours <= 0) {
        throw httpsError("invalid-argument", "durationHours must represent 1 to 30 days.");
      }
      rawDuration = Math.ceil(hours / 24);
    }
    values.voteDurationDays = contestInteger(rawDuration, "voteDurationDays", 1, 30);
  }

  const autoCancel = firstAlias(body, ["autoCancelHours"]);
  if (autoCancel.present || creating) {
    recognized ||= autoCancel.present;
    values.autoCancelHours = contestInteger(autoCancel.present ? autoCancel.value : 24, "autoCancelHours", 1, 168);
  }

  const minVotes = firstAlias(body, ["minVotes"]);
  if (minVotes.present || creating) {
    recognized ||= minVotes.present;
    values.minVotes = contestInteger(minVotes.present ? minVotes.value : 0, "minVotes", 0, 1_000_000);
  }

  const banner = firstAlias(body, ["bannerUrl", "bannerImageUrl"]);
  if (banner.present || creating) {
    recognized ||= banner.present;
    values.bannerUrl = contestBannerUrl(banner.present ? banner.value : null);
  }

  // Validity window. Default null on create — "no expiry", which is how every
  // contest that existed before this feature behaves, so seed scripts and any
  // older client that posts without these keys are unaffected.
  const startsAt = firstAlias(body, ["startsAt", "startAt", "startDate"]);
  if (startsAt.present || creating) {
    recognized ||= startsAt.present;
    values.startsAt = contestTimestamp(startsAt.present ? startsAt.value : null, "startsAt");
  }

  const endsAt = firstAlias(body, ["endsAt", "endAt", "endDate", "validUntil", "expiresAt"]);
  if (endsAt.present || creating) {
    recognized ||= endsAt.present;
    values.endsAt = contestTimestamp(endsAt.present ? endsAt.value : null, "endsAt");
  }

  for (const [field, maxLength] of [["description", 1000], ["rules", 5000]] as const) {
    if (hasOwn(body, field)) {
      recognized = true;
      values[field] = contestText(body[field], field, maxLength);
    }
  }

  return { recognized, values };
}

export function cleanContestExtra(value: unknown): Record<string, any> {
  const extra = isRecord(value) ? { ...value } : {};
  for (const key of CONTEST_CANONICAL_EXTRA_KEYS) delete extra[key];
  return extra;
}

export function createContestExtra(body: Record<string, any>, values: Record<string, any>): Record<string, any> {
  const nested = isRecord(body.extra) ? body.extra : {};
  const extra = cleanContestExtra({ ...nested, ...body });
  delete extra.extra;
  if (hasOwn(values, "description")) extra.description = values.description;
  if (hasOwn(values, "rules")) extra.rules = values.rules;
  return extra;
}
