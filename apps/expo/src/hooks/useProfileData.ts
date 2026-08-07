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

      const profile = await readApi(`/read/users/${userId}`);
      if (profile) return { ...profile, uid: userId } as UserProfile;

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

export const useUserBookmarks = (userId: string) => {
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
    enabled: !!userId,
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
