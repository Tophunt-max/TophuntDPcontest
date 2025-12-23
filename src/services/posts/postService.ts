import { httpsCallable } from 'firebase/functions';
import { functions, auth } from '../firebase/initFirebase';

export interface CreatePostParams {
  mediaUrl: string;
  mediaType: 'image' | 'video';
  caption?: string;
  location?: string;
}

export const createPost = async (params: CreatePostParams) => {
  const user = auth.currentUser;
  if (!user) throw new Error('User not authenticated');

  const createPostFn = httpsCallable(functions, 'createPost');

  try {
    const result = await createPostFn(params);
    return result.data as { success: boolean; postId: string };
  } catch (error: any) {
    console.error("createPost Error:", error);
    throw error;
  }
};

export const deletePost = async (postId: string) => {
  const user = auth.currentUser;
  if (!user) throw new Error('User not authenticated');

  const deletePostFn = httpsCallable(functions, 'deleteUserPost');

  try {
    const result = await deletePostFn({ postId });
    return result.data as { success: boolean; message: string };
  } catch (error: any) {
    console.error("deletePost Error:", error);
    throw error;
  }
};
