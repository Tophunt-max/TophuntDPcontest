/**
 * The upload folder allow-list must cover what the app actually sends.
 *
 * `POST /upload` validates the requested folder against `USER_UPLOAD_FOLDERS`,
 * which is the right shape — that endpoint writes wherever it is told, so an
 * unconstrained prefix let any authenticated user drop objects into
 * deployment-owned paths.
 *
 * But when that list was introduced it omitted two folders the client was already
 * using, and the failure was total and silent from the server's point of view:
 * every contest entry upload and every manual deposit screenshot came back 400,
 * so no battle could be created or joined and no manual top-up could be filed.
 *
 * This test exists because a server-side allow-list and a client-side constant
 * are two halves of one contract that nothing else checks. Adding a new upload
 * folder to the app now requires adding it here too, which is exactly the
 * conversation that should happen.
 */
import { describe, it, expect } from 'vitest';
import { USER_UPLOAD_FOLDERS, sanitizeMediaFolder } from '../src/lib/r2';

/**
 * Every folder string the Expo app passes to `uploadToR2(uri, mime, folder)`,
 * with where it comes from. Keep in sync with the client:
 *
 *   contests  — src/services/contests/uploadMedia.ts (photo + video entries)
 *   stories   — app/story/create/index.tsx
 *   avatars   — app/profile/manage/edit.tsx, app/auth/signup/congratulations
 *   deposits  — app/wallet/deposit.tsx
 */
const FOLDERS_THE_CLIENT_SENDS = ['contests', 'stories', 'avatars', 'deposits'] as const;

describe('USER_UPLOAD_FOLDERS', () => {
  it.each(FOLDERS_THE_CLIENT_SENDS)('accepts %s, which the app uploads to', (folder) => {
    // Mirrors what routes/upload.ts does: sanitise, then check membership.
    const sanitised = sanitizeMediaFolder(folder);
    expect(sanitised).toBe(folder);
    expect(USER_UPLOAD_FOLDERS as readonly string[]).toContain(sanitised);
  });

  it('still refuses a folder the app never uses', () => {
    // The list is an allow-list, not decoration — it must actually exclude things.
    expect(USER_UPLOAD_FOLDERS as readonly string[]).not.toContain('contest-banners');
    expect(USER_UPLOAD_FOLDERS as readonly string[]).not.toContain('anything-else');
  });

  it('keeps deployment-owned banner objects out of reach', () => {
    // contest-banners is treated as deployment-owned by
    // contestBannerKeyFromPublicUrl and is deleted by the contest lifecycle, so a
    // user who could write there could plant or clobber banners.
    expect(USER_UPLOAD_FOLDERS as readonly string[]).not.toContain('contest-banners');
  });

  it('collapses traversal and junk to a safe single segment', () => {
    expect(sanitizeMediaFolder('../../etc')).toBe('etc');
    expect(sanitizeMediaFolder('/absolute/path')).toBe('absolute/path');
    expect(sanitizeMediaFolder('')).toBe('misc');
    expect(sanitizeMediaFolder(undefined)).toBe('misc');
    expect(sanitizeMediaFolder('..')).toBe('misc');
    // Sanitising alone is not authorisation — the membership check is what
    // rejects these, since e.g. "etc" is not in the allow-list.
    expect(USER_UPLOAD_FOLDERS as readonly string[]).not.toContain('etc');
  });
});
