import { auth } from '../firebase/initFirebase';
import { callApi } from '../api'; // Naya centralized API caller

export interface CreatePostParams {
  mediaUrl: string;
  mediaType: 'image' | 'video';
  caption?: string;
  location?: string;
}

export const createPost = async (params: CreatePostParams) => {
  const user = auth.currentUser;
  if (!user) throw new Error('User not authenticated');

  try {
    // Purana: httpsCallable(functions, 'createPost')
    // Ab: 'createPost' action in API router
    return await callApi('createPost', params);
  } catch (error: any) {
    console.error("createPost Error:", error);
    throw error;
  }
};

export const deletePost = async (postId: string) => {
  const user = auth.currentUser;
  if (!user) throw new Error('User not authenticated');

  try {
    // Purana: httpsCallable(functions, 'deleteUserPost')
    // Ab: 'deletePost' action in API router
    return await callApi('deletePost', { postId });
  } catch (error: any) {
    console.error("deletePost Error:", error);
    throw error;
  }
};
