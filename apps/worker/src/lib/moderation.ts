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

/** The first banned word found in any of the given texts, or null. */
export async function findBannedWord(env: Env, ...texts: (string | null | undefined)[]): Promise<string | null> {
  const words = await getBannedWords(env);
  if (!words.length) return null;
  const hay = texts.filter(Boolean).join(" \n ").toLowerCase();
  if (!hay.trim()) return null;
  for (const w of words) {
    if (!w) continue;
    // Word-boundary match so "class" doesn't trip on "ass".
    const re = new RegExp(`\\b${escapeRegex(w)}\\b`, "i");
    if (re.test(hay)) return w;
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
