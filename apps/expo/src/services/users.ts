import { collection, getDocs, limit, query, where } from "firebase/firestore";
import { firestore as db } from "../services/firebase/initFirebase";
import { getFunctions, httpsCallable } from "firebase/functions";
import { app } from "../firebaseConfig";

const functions = getFunctions(app);

export async function fetchSuggestedUsers() {
  try {
    // For now, let's just fetch real users instead of "suggestedUsers" collection
    // Limit to 20 for performance
    const q = query(collection(db, "users"), limit(20));
    const snap = await getDocs(q);
    
    return snap.docs.map((d) => {
      const data = d.data();
      return { 
        id: d.id, 
        name: data.fullName || data.username || "User",
        username: data.username || "",
        avatar: data.profileImageUrl || "https://ui-avatars.com/api/?name=" + (data.fullName || "User") + "&background=random"
      };
    });
  } catch (error) {
    console.error("Error fetching suggested users:", error);
    return [];
  }
}

/**
 * Calls the toggleFollow cloud function to follow or unfollow a user.
 * @param targetUserId The ID of the user to follow or unfollow.
 * @returns A promise that resolves with the result of the function call.
 */
export const toggleFollowService = async (targetUserId: string) => {
  try {
    const toggleFollowFunction = httpsCallable(functions, 'toggleFollow');
    const result = await toggleFollowFunction({ targetUserId });
    return result.data;
  } catch (error) {
    console.error("Error calling toggleFollow function:", error);
    throw error; // Re-throw the error to be handled by the caller
  }
};
