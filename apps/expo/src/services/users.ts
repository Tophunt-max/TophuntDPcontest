import { collection, doc, getDocs, limit, query, updateDoc, where, getDoc } from "firebase/firestore";
import { firestore as db } from "../services/firebase/initFirebase";
import { callApi } from "./api"; // Naya centralized API caller
import { Badge } from "../types/user";

/**
 * Calculates distance between two coordinates in km (Haversine formula)
 */
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

export async function fetchSuggestedUsers(currentUserCoords?: { lat: number, lng: number }) {
  try {
    console.log("Algorithm: Fetching suggested users...");
    
    // FETCH ANY USERS (to ensure list is not empty during testing)
    const q = query(collection(db, "users"), limit(50));
    const snap = await getDocs(q);
    
    if (snap.empty) {
        console.log("Firestore users collection is EMPTY.");
        return [];
    }

    let users = snap.docs.map((d) => {
      const data = d.data();
      return { 
        id: d.id, 
        name: data.fullName || data.username || "User",
        username: data.username || "user",
        avatar: data.profileImageUrl || `https://ui-avatars.com/api/?name=${data.fullName || data.username || "User"}&background=random`,
        coords: data.coordinates || null,
      };
    });

    // Proximity Sorting Algorithm
    if (currentUserCoords && currentUserCoords.lat && currentUserCoords.lng) {
      console.log("Sorting users by proximity to current user...");
      users = users.sort((a, b) => {
        if (!a.coords) return 1;
        if (!b.coords) return -1;
        
        const distA = calculateDistance(currentUserCoords.lat, currentUserCoords.lng, a.coords.lat, a.coords.lng);
        const distB = calculateDistance(currentUserCoords.lat, currentUserCoords.lng, b.coords.lat, b.coords.lng);
        
        return distA - distB;
      });
    }

    console.log(`Fetched and sorted ${users.length} users.`);
    return users.slice(0, 20);

  } catch (error) {
    console.error("Critical error in fetchSuggestedUsers:", error);
    return [];
  }
}

export const toggleFollowService = async (targetUserId: string) => {
  try {
    // Purana: httpsCallable(functions, 'toggleFollow') tha
    // Ab: Central API caller use hoga
    return await callApi('toggleFollow', { targetUserId });
  } catch (error) {
    console.error("Error calling toggleFollow service:", error);
    throw error;
  }
};

export const equipBadgeService = async (userId: string, badge: Badge | null) => {
    try {
        const userRef = doc(db, "users", userId);
        await updateDoc(userRef, { equippedBadge: badge });
        return { success: true };
    } catch (error) {
        console.error("Error equipping badge:", error);
        throw error;
    }
};
