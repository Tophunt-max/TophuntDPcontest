import { callApi, readApi } from "./api";
import { Badge } from "../types/user";

/** Haversine distance in km. */
function calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number) {
  const R = 6371;
  const dLat = deg2rad(lat2 - lat1);
  const dLon = deg2rad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}
function deg2rad(deg: number) {
  return deg * (Math.PI / 180);
}

export async function fetchSuggestedUsers(currentUserCoords?: { lat: number; lng: number }) {
  try {
    // Reads users from the Worker (D1) instead of Firestore.
    const raw: any[] = (await readApi("/read/users/suggested", { limit: 50 })) || [];
    if (!raw.length) return [];

    let users = raw.map((data) => ({
      id: data.id,
      name: data.fullName || data.username || "User",
      username: data.username || "user",
      // Null when unset — the UI renders local initials via <Avatar>. Do not
      // substitute a third-party avatar URL here (it leaks the username).
      avatar: data.profileImageUrl || null,
      verified: !!data.verified,
      coords: data.coordinates || null,
    }));

    // Proximity sorting (unchanged, done client-side).
    if (currentUserCoords && currentUserCoords.lat && currentUserCoords.lng) {
      users = users.sort((a, b) => {
        if (!a.coords) return 1;
        if (!b.coords) return -1;
        const distA = calculateDistance(currentUserCoords.lat, currentUserCoords.lng, a.coords.lat, a.coords.lng);
        const distB = calculateDistance(currentUserCoords.lat, currentUserCoords.lng, b.coords.lat, b.coords.lng);
        return distA - distB;
      });
    }

    return users.slice(0, 20);
  } catch (error) {
    console.error("Critical error in fetchSuggestedUsers:", error);
    return [];
  }
}

/**
 * Server-side user search (username prefix match, min 2 chars). Backed by the
 * Worker's /read/users/search endpoint, so results aren't limited to the
 * already-loaded suggested list.
 */
export async function searchUsers(q: string) {
  const query = q.trim();
  if (query.length < 2) return [];
  try {
    const raw: any[] = (await readApi("/read/users/search", { q: query })) || [];
    return raw.map((d) => ({
      id: d.id,
      name: d.fullName || d.username || "User",
      username: d.username || "user",
      // See note in fetchSuggestedUsers — null, not a remote placeholder.
      avatar: d.avatarUrl || d.profileImageUrl || null,
      verified: !!d.verified,
    }));
  } catch (error) {
    console.error("Error searching users:", error);
    return [];
  }
}

export const toggleFollowService = async (targetUserId: string) => {
  try {
    return await callApi("toggleFollow", { targetUserId });
  } catch (error) {
    console.error("Error calling toggleFollow service:", error);
    throw error;
  }
};

/**
 * Block / mute.
 *
 * Explicit set-and-clear rather than toggles, mirroring the Worker actions: a
 * double-tap or a retried request must never quietly undo a block.
 *
 * Blocking is mutual and hard (neither user sees the other anywhere, and every
 * interaction between them is refused). Muting is one-way and silent — the muted
 * user is never told and keeps every ability they had.
 */
export const blockUserService = (targetUserId: string) => callApi('blockUser', { targetUserId });
export const unblockUserService = (targetUserId: string) => callApi('unblockUser', { targetUserId });
export const muteUserService = (targetUserId: string) => callApi('muteUser', { targetUserId });
export const unmuteUserService = (targetUserId: string) => callApi('unmuteUser', { targetUserId });

/** Report a user to moderation. First client caller of the `createReport` action. */
export const reportUserService = (targetUserId: string, reason: string) =>
  callApi('createReport', { targetType: 'user', targetId: targetUserId, reason });

/** The signed-in user's own block and mute lists (outgoing relations only). */
export interface BlockedAccount {
  uid: string;
  username: string | null;
  fullName: string | null;
  profileImageUrl: string | null;
  profileImageUrlThumb: string | null;
}
export async function fetchBlockedAccounts(): Promise<{ blocked: BlockedAccount[]; muted: BlockedAccount[] }> {
  const res: any = await readApi('/read/blocked');
  return { blocked: res?.blocked || [], muted: res?.muted || [] };
}

export const equipBadgeService = async (_userId: string, badge: Badge | null) => {
  try {
    // Was updateDoc(users/{uid}, { equippedBadge }); now a Worker action.
    return await callApi("equipBadge", { badge });
  } catch (error) {
    console.error("Error equipping badge:", error);
    throw error;
  }
};

/**
 * What a `/@handle` lookup resolved to.
 *
 * `status` is a discriminant rather than a bag of optional fields because the caller
 * has to tell "no such account" from "we could not ask" — and those two render
 * differently. See `fetchProfileByHandle`.
 */
export type HandleResolution =
  /** The handle is live. */
  | { status: 'found'; profile: any }
  /**
   * The handle was RELEASED by its owner and nobody holds it now. The caller should
   * navigate to `/@<movedTo>` rather than render.
   */
  | { status: 'moved'; movedTo: string }
  /** The API answered, authoritatively, that no such handle exists. */
  | { status: 'not-found' }
  /** The lookup could not be completed. NOT the same as not-found. */
  | { status: 'unavailable' };

/**
 * Resolve a public `/@handle` to a profile.
 *
 * Backs the public profile url. It used to be `/profile?userId=<uid>`, which put the
 * internal Firebase uid into every shared link and browser history entry; the handle
 * is what a person can actually read, share and type.
 *
 * `moved` is the interesting case. A username is mutable, so a readable url can rot —
 * the Worker answers a released handle with the account's CURRENT handle so an old link
 * still finds the person instead of dying. Whoever holds a handle today always wins over
 * history, so this can never point at someone who has since taken the name legitimately.
 *
 * ---------------------------------------------------------------------------
 * `not-found` and `unavailable` are deliberately DIFFERENT answers
 * ---------------------------------------------------------------------------
 * This originally collapsed both into one empty result, and the screen rendered
 * "This account doesn't exist or is no longer available" for either. So a dropped
 * connection told the visitor that a real profile — usually one they had just followed
 * a link to — did not exist, with no retry affordance and nothing to suggest trying
 * again would help.
 *
 * The edge Worker already takes care to distinguish these: it answers 404 for an
 * unknown handle and 503 for an unreachable API, precisely so a bad minute upstream
 * does not get reported as a missing page. The client has the same obligation to the
 * person holding the link.
 */
export async function fetchProfileByHandle(handle: string): Promise<HandleResolution> {
  const clean = String(handle || '').trim().replace(/^@+/, '');
  if (!clean) return { status: 'not-found' };
  try {
    const raw: any = await readApi(`/read/users/by-username/${encodeURIComponent(clean)}`);
    // A `null` body is the Worker's authoritative "no such handle" — it uses the same
    // shape as `/read/users/:id` so callers have one not-found form to handle.
    if (!raw) return { status: 'not-found' };
    if (raw.movedTo) return { status: 'moved', movedTo: String(raw.movedTo) };
    return { status: 'found', profile: raw };
  } catch {
    return { status: 'unavailable' };
  }
}

/** The canonical public path for a handle. Lowercase, so one profile has ONE url. */
export function profilePath(username: string | null | undefined): string | null {
  const clean = String(username || '').trim().replace(/^@+/, '').toLowerCase();
  return clean ? `/@${clean}` : null;
}
