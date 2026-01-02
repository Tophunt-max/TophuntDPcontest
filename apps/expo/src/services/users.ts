import { collection, doc, getDocs, limit, query, updateDoc, where } from "firebase/firestore";
import { firestore as db } from "../services/firebase/initFirebase";
import { getFunctions, httpsCallable } from "firebase/functions";
import { app } from "../firebaseConfig";
import { Badge } from "../types/user";

const functions = getFunctions(app);

export async function fetchSuggestedUsers() {
  try {
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

export const toggleFollowService = async (targetUserId: string) => {
  try {
    const toggleFollowFunction = httpsCallable(functions, 'toggleFollow');
    const result = await toggleFollowFunction({ targetUserId });
    return result.data;
  } catch (error) {
    console.error("Error calling toggleFollow function:", error);
    throw error;
  }
};

/**
 * Updates the user's equipped badge in Firestore.
 */
export const equipBadgeService = async (userId: string, badge: Badge | null) => {
    try {
        const userRef = doc(db, "users", userId);
        await updateDoc(userRef, {
            equippedBadge: badge
        });
        return { success: true };
    } catch (error) {
        console.error("Error equipping badge:", error);
        throw error;
    }
};
