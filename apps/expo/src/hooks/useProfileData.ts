import { useQuery, useMutation, useQueryClient, useInfiniteQuery } from '@tanstack/react-query';
import { UserProfile, Post } from '../types/user';
import { useAuth } from '../services/auth';
import { callApi, readApi } from '../services/api';

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

      // Self with no profile row yet -> create a default one.
      if (currentUser && currentUser.uid === userId) {
        const newProfile: any = {
          username:
            currentUser.displayName?.replace(/\s+/g, '').toLowerCase() || `user_${userId.slice(0, 5)}`,
          fullName: currentUser.displayName || 'New User',
          avatarUrl: currentUser.photoURL || '',
          bio: 'Hi there! I am new here.',
          isPrivate: false,
        };
        await callApi('updateProfile', newProfile);
        return {
          uid: userId,
          email: currentUser.email || '',
          ...newProfile,
          profileImageUrl: newProfile.avatarUrl,
        } as UserProfile;
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

export const useToggleFollow = () => {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async (targetUserId: string) => {
      if (!user) throw new Error("Authentication required");
      return await callApi('toggleFollow', { targetUserId });
    },
    onSuccess: (_, targetUserId) => {
      queryClient.invalidateQueries({ queryKey: ['profile', targetUserId] });
      queryClient.invalidateQueries({ queryKey: ['profile', user?.uid] });
    },
  });
};
