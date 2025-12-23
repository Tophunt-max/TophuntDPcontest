import { collection, getDocs, limit, query, where } from "firebase/firestore";
import { firestore as db } from "../services/firebase/initFirebase";

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
