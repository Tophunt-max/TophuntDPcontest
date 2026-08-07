import { callApi } from '@/src/services/api';

/**
 * Starts (or reuses) a 1:1 chat via the Worker (/api startChat), which handles
 * the "does a chat already exist between these two users" dedupe in D1.
 * Returns the chatId.
 */
export const startChat = async (otherUserId: string, otherUserData: any): Promise<string> => {
  try {
    const res: any = await callApi('startChat', { otherUserId, otherUserData });
    return res.chatId;
  } catch (error) {
    console.error("[startChat] Error:", error);
    throw error;
  }
};
