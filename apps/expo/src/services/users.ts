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
