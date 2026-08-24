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
  "endDate",
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
