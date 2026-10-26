import { useQuery, useMutation, useQueryClient, useInfiniteQuery } from '@tanstack/react-query';
import { UserProfile, Post } from '../types/user';
import { useAuth } from '../services/auth';
import { callApi, readApi } from '../services/api';
import {
  blockUserService,
  fetchBlockedAccounts,
  fetchFollowRequestCount,
  fetchFollowRequestsPage,
  respondFollowRequestService,
  muteUserService,
  unblockUserService,
  unmuteUserService,
} from '../services/users';
import { bumpSocialGraphVersion } from '../lib/socialGraphVersion';
import { isProfileComplete, markOnboardingIncomplete, PROFILE_INCOMPLETE_CODE } from '../lib/profileCompletion';
import { followStateFromResult, type FollowIntent, type FollowState, type ToggleFollowResult } from '../lib/followState';

/**
 * Profile data now comes from the Cloudflare Worker (D1) via /read endpoints.
 */
export const useProfile = (userId: string) => {
  const { user: currentUser } = useAuth();

  return useQuery({
    queryKey: ['profile', userId],
    queryFn: async (): Promise<UserProfile> => {
      if (!userId) throw new Error("No User ID");

      const raw: any = await readApi(`/read/users/${userId}`);
      // My own row exists but onboarding is unfinished (a half-created account):
      // the root guard takes me back to the profile form.
      if (raw && currentUser && currentUser.uid === userId && !isProfileComplete(raw)) markOnboardingIncomplete(userId);
      if (raw) {
        // The Worker returns a flat user row (lowercase dpcoin, top-level
        // wins/contestsJoined/totalVotesReceived). Map it into the UserProfile
        // shape the UI expects so wallet balance and stats aren't stuck at 0.
        return {
          ...raw,
          uid: userId,
          Dpcoin: raw.Dpcoin ?? raw.dpcoin ?? 0,
          profileImageUrl: raw.profileImageUrl ?? raw.avatarUrl ?? '',
          isAdmin: raw.isAdmin ?? raw.role === 'admin',
          stats: raw.stats ?? {
            contestsJoined: raw.contestsJoined ?? 0,
            wins: raw.wins ?? 0,
            totalVotesReceived: raw.totalVotesReceived ?? 0,
          },
        } as UserProfile;
      }

      // Self with no profile row: onboarding was never finished. This used to
      // AUTO-CREATE a profile with made-up defaults (bio "Hi there! I am new
      // here.", a username derived from the provider name), which is how leaving
      // the signup form with Back produced a full account with no age check.
      // Accounts are created only by the signup steps (`createProfile`); hand the
      // user back to them instead.
      if (currentUser && currentUser.uid === userId) {
        markOnboardingIncomplete(userId);
        throw new Error(`${PROFILE_INCOMPLETE_CODE}: Finish creating your profile to continue.`);
      }

      throw new Error("User profile not found");
    },
    enabled: !!userId,
  });
};

export const useUserPosts = (userId: string) => {
  return useInfiniteQuery({
    queryKey: ['userPosts', userId],
    queryFn: async ({ pageParam = null }) => {
      try {
        const res: any = await readApi(`/read/users/${userId}/posts`, { cursor: pageParam ?? undefined });
        const posts: Post[] = (res?.posts || []) as Post[];
        return { posts, lastVisible: res?.nextCursor ?? null };
      } catch (err) {
        return { posts: [], lastVisible: null };
      }
    },
    getNextPageParam: (lastPage) => lastPage.lastVisible || undefined,
    initialPageParam: null,
    enabled: !!userId,
  });
};

/**
 * A user's own battles (as either participant), optionally filtered by type.
 * The same battle appears on both creators' profiles (server matches on either
 * participant uid). Returns mapped match objects ready for <PostCard/>.
 */
export const useUserMatches = (userId: string, type: 'photo' | 'video', enabled = true) => {
  return useQuery({
    queryKey: ['userMatches', userId, type],
    queryFn: async (): Promise<any[]> => {
      try {
        return (await readApi(`/read/users/${userId}/matches`, { type, limit: 12 })) as any[];
      } catch (err) {
        console.error('Error fetching user matches:', err);
        return [];
      }
    },
    // Only the active tab fetches; already-loaded tabs stay cached (no refetch
    // for 30s when switching back and forth).
    enabled: !!userId && enabled,
    staleTime: 30_000,
  });
};

/** Battles this user has won (completed + winnerUid === user). */
export const useUserWins = (userId: string) => {
  return useQuery({
    queryKey: ['userWins', userId],
    queryFn: async (): Promise<any[]> => {
      try {
        return (await readApi(`/read/users/${userId}/matches`, { won: 1, limit: 30 })) as any[];
      } catch (err) {
        console.error('Error fetching wins:', err);
        return [];
      }
    },
    enabled: !!userId,
    staleTime: 30_000,
  });
};

export const useUserBookmarks = (userId: string, enabled = true) => {
  return useQuery({
    queryKey: ['userBookmarks', userId],
    queryFn: async () => {
      try {
        return (await readApi(`/read/users/${userId}/bookmarks`)) as any[];
      } catch (err) {
        console.error("Error fetching bookmarks:", err);
        return [];
      }
    },
    // Fetched only when the Saved tab is opened.
    enabled: !!userId && enabled,
    staleTime: 30_000,
  });
};

/**
 * The signed-in viewer's relationship to `targetUserId`: following, requested
 * (a pending request to a private account), none, or self. Its own query so
 * the profile itself can stay a shared, viewer-agnostic cache entry.
 */
export const useRelationship = (targetUserId: string, enabled = true) => {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['relationship', targetUserId, user?.uid],
    queryFn: async (): Promise<FollowState> => {
      const res: any = await readApi(`/read/users/${targetUserId}/relationship`);
      const s = res?.state;
      return s === 'following' || s === 'requested' || s === 'self' ? s : 'none';
    },
    enabled: !!user && !!targetUserId && enabled,
    staleTime: 15_000,
  });
};

export const useToggleFollow = () => {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async ({ targetUserId, intent }: { targetUserId: string; intent: FollowIntent }): Promise<ToggleFollowResult> => {
      if (!user) throw new Error("Authentication required");
      return (await callApi('toggleFollow', { targetUserId, intent })) as ToggleFollowResult;
    },
    onSuccess: (result, { targetUserId }) => {
      // The server's answer is authoritative: a private account answers
      // `requested`, not `following`.
      queryClient.setQueryData(['relationship', targetUserId, user?.uid], followStateFromResult(result));
      queryClient.invalidateQueries({ queryKey: ['profile', targetUserId] });
      queryClient.invalidateQueries({ queryKey: ['profile', user?.uid] });
      // Following (or unfollowing) a PRIVATE account changes what is unlocked.
      queryClient.invalidateQueries({ queryKey: ['userMatches', targetUserId] });
      queryClient.invalidateQueries({ queryKey: ['userWins', targetUserId] });
    },
  });
};

/** The owner's pending follow requests (private accounts), paged by cursor. */
export const useFollowRequests = () => {
  const { user } = useAuth();
  return useInfiniteQuery({
    queryKey: ['followRequests', user?.uid],
    queryFn: ({ pageParam }) => fetchFollowRequestsPage(pageParam),
    initialPageParam: null as string | null,
    // A page can come back short (hidden requesters are filtered after the
    // LIMIT) yet still have a next cursor, so the cursor alone decides.
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: !!user,
    staleTime: 10_000,
  });
};

export const useFollowRequestCount = () => {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['followRequestCount', user?.uid],
    queryFn: fetchFollowRequestCount,
    enabled: !!user,
    staleTime: 15_000,
  });
};

/** Confirm (`accept: true`) or delete a request. Refreshes the list, the count and both profiles. */
export const useRespondFollowRequest = () => {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  return useMutation({
    mutationFn: ({ requesterId, accept }: { requesterId: string; accept: boolean }) =>
      respondFollowRequestService(requesterId, accept),
    onSettled: (_r, _e, { requesterId }) => {
      // On error too: a refused confirm (e.g. after a block) has already
      // removed the request server-side.
      queryClient.invalidateQueries({ queryKey: ['followRequests'] });
      queryClient.invalidateQueries({ queryKey: ['followRequestCount'] });
      queryClient.invalidateQueries({ queryKey: ['profile', user?.uid] });
      queryClient.invalidateQueries({ queryKey: ['profile', requesterId] });
    },
  });
};

/**
 * The signed-in user's block and mute lists (outgoing relations only — who has
 * blocked *you* is deliberately not knowable).
 */
export const useBlockedAccounts = () => {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['blockedAccounts', user?.uid],
    queryFn: fetchBlockedAccounts,
    enabled: !!user,
    staleTime: 30_000,
  });
};

/**
 * React-query keys a block or mute invalidates.
 *
 * These are the keys that ACTUALLY exist — verified against the codebase rather
 * than written from the list of affected surfaces, which is a longer list. The
 * home feed, the chat list, the notification inbox, the leaderboard and the
 * comment sheets do not use react-query at all: they hold their data in component
 * state and reload on mount, tab change or pull-to-refresh. Naming invented keys
 * like 'feed' or 'chats' here would look like those surfaces were handled while
 * doing nothing, which is worse than the honest short list.
 *
 * Those state-based screens are covered by the server: every one of them refetches
 * from a `/read` endpoint that now filters, so they correct themselves the next
 * time they load. The gap is the few seconds a screen that is already mounted
 * keeps showing stale content — see the note in UserActionsSheet.
 */
const QUERY_KEYS_AFFECTED_BY_BLOCK = [
  'profile', // both users: follower/following counts moved
  'blockedAccounts',
  'stories',
  'highlights',
  'userMatches',
  'userPosts',
  'userBookmarks', // a saved battle involving the blocked user is now hidden
  'userWins',
  // A block deletes the follow edges and pending requests both ways, so the
  // Follow button and the requests inbox/badge must refetch too. They kept
  // showing "Following"/"Requested" and the removed requester.
  'relationship',
  'followRequests',
  'followRequestCount',
];

function useBlockMutation(fn: (targetUserId: string) => Promise<any>) {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  return useMutation({
    mutationFn: async (targetUserId: string) => {
      if (!user) throw new Error('Authentication required');
      return fn(targetUserId);
    },
    onSuccess: () => {
      // Tells the state-based screens (the home feed) that they are stale. See
      // socialGraphVersion.ts for why they can't simply be invalidated.
      bumpSocialGraphVersion();
      for (const key of QUERY_KEYS_AFFECTED_BY_BLOCK) {
        // Prefix match, so ['profile', uid] and ['userMatches', uid, 'photo'] are
        // both covered without naming every uid.
        queryClient.invalidateQueries({ queryKey: [key] });
      }
    },
  });
}

export const useBlockUser = () => useBlockMutation(blockUserService);
export const useUnblockUser = () => useBlockMutation(unblockUserService);
export const useMuteUser = () => useBlockMutation(muteUserService);
export const useUnmuteUser = () => useBlockMutation(unmuteUserService);

/**
 * React-query keys that carry a rendered copy of the signed-in user's avatar.
 *
 * The server now refreshes the photo on every `/read` (it looks the current
 * value up live rather than trusting the snapshot each surface froze), so these
 * screens only need a reason to refetch. Same honest short list as
 * QUERY_KEYS_AFFECTED_BY_BLOCK: the home feed, chat inbox, notification list and
 * leaderboard are state-based, not react-query, so they are NOT listed here —
 * they are covered by getSocialGraphVersion() (see below) and by reloading on
 * focus/pull-to-refresh against a server that already returns the new photo.
 */
const QUERY_KEYS_SHOWING_OWN_AVATAR = [
  'profile',
  'userMatches', // the user's own battles show their face on both cards
  'userPosts',
  'userWins',
  'userBookmarks',
  'stories',
  'highlights',
];

/**
 * Propagate the signed-in user's just-changed profile photo across the session.
 *
 * The edit screen already refetches its own `['profile', uid]`, but the new
 * photo also appears on the user's battles, stories and — via the state-based
 * home feed — their own cards there. Invalidate the react-query surfaces and
 * bump the feed version so the already-mounted feed reloads on next focus; the
 * server returns the fresh photo, so a reload is all any surface needs.
 */
export function propagateOwnAvatarChange(queryClient: ReturnType<typeof useQueryClient>): void {
  for (const key of QUERY_KEYS_SHOWING_OWN_AVATAR) {
    queryClient.invalidateQueries({ queryKey: [key] });
  }
  // The home feed is not react-query; it reloads on focus when this version
  // moves. A changed avatar is exactly a "what the feed renders has changed".
  bumpSocialGraphVersion();
}
