/**
 * Lightweight content moderation — rejects text containing admin-managed banned
 * words (see the admin panel Moderation page + banned_words table).
 *
 * The word list is cached per-isolate for a short TTL to avoid a DB read on
 * every post/comment/profile write.
 */
import type { Env } from "../types";
import { getDb, schema } from "../db";
import { httpsError } from "./http";

let cache: { words: string[]; at: number } | null = null;
const TTL_MS = 60_000;

export async function getBannedWords(env: Env): Promise<string[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.words;
  try {
    const db = getDb(env);
    const rows = await db.select({ word: schema.bannedWords.word }).from(schema.bannedWords).all();
    cache = { words: rows.map((r) => (r.word || "").toLowerCase()).filter(Boolean), at: Date.now() };
  } catch {
    // Fail open — never block writes because moderation lookup failed.
    cache = { words: [], at: Date.now() };
  }
  return cache.words;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Common look-alike substitutions ("5c4m" → "scam"). */
const LEET: Record<string, string> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b", "@": "a", "$": "s", "!": "i" };

/**
 * The text as it is read, not as it is typed: Unicode-folded (full-width and
 * accented letters to plain ones), look-alike digits and symbols mapped to
 * letters, and separators BETWEEN single letters removed ("s.c.a.m", "s c a m").
 * The plain list match was beaten by any of these.
 */
export function normaliseForModeration(text: string): string {
  const folded = text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[0134578@$!]/g, (ch) => LEET[ch] ?? ch);
  // "s.c.a.m" / "s c a m" / "s-c-a-m": join runs of single letters split by one
  // separator, so spaced-out words read as one word.
  return folded.replace(/\b(?:[a-z][\s._*-]){2,}[a-z]\b/g, (run) => run.replace(/[\s._*-]/g, ""));
}

/** The first banned word found in any of the given texts, or null. */
export async function findBannedWord(env: Env, ...texts: (string | null | undefined)[]): Promise<string | null> {
  const words = await getBannedWords(env);
  if (!words.length) return null;
  const raw = texts.filter(Boolean).join(" \n ");
  if (!raw.trim()) return null;
  // Checked against both the typed text and its normalised reading.
  const hays = [raw.toLowerCase(), normaliseForModeration(raw)];
  for (const w of words) {
    if (!w) continue;
    // Word-boundary match so "class" doesn't trip on "ass".
    const re = new RegExp(`\\b${escapeRegex(w)}\\b`, "i");
    if (hays.some((h) => re.test(h))) return w;
  }
  return null;
}

/** Throw an invalid-argument error if any text contains a banned word. */
export async function assertClean(env: Env, ...texts: (string | null | undefined)[]): Promise<void> {
  const found = await findBannedWord(env, ...texts);
  if (found) {
    throw httpsError("invalid-argument", "Your content contains words that are not allowed.");
  }
}
