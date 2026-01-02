import * as logos from "@/assets/logos";
import { db } from "@/lib/firebase/admin";

function serializeFirestoreData(data: any) {
  if (!data) return data;
  const serialized = { ...data };
  for (const key in serialized) {
    if (serialized[key] && typeof serialized[key].toDate === "function") {
      serialized[key] = serialized[key].toDate().toISOString();
    } else if (serialized[key] && typeof serialized[key] === "object" && !Array.isArray(serialized[key])) {
      serialized[key] = serializeFirestoreData(serialized[key]);
    }
  }
  return serialized;
}

export async function getUsers() {
  try {
    const usersSnapshot = await db.collection("users").limit(100).get();
    return usersSnapshot.docs.map(doc => ({
      id: doc.id,
      ...serializeFirestoreData(doc.data())
    }));
  } catch (error: any) {
    console.error("Error fetching users:", error.message);
    return [];
  }
}

export async function getPosts() {
    try {
      const snapshot = await db.collection("posts").orderBy("createdAt", "desc").limit(100).get();
      return snapshot.docs.map(doc => ({
        id: doc.id,
        ...serializeFirestoreData(doc.data())
      }));
    } catch (error: any) {
      console.error("Error fetching posts:", error.message);
      return [];
    }
}

export async function getStories() {
    try {
      const snapshot = await db.collection("stories").orderBy("createdAt", "desc").limit(100).get();
      return snapshot.docs.map(doc => ({
        id: doc.id,
        ...serializeFirestoreData(doc.data())
      }));
    } catch (error: any) {
      console.error("Error fetching stories:", error.message);
      return [];
    }
}

export async function getUserById(id: string) {
  try {
    const doc = await db.collection("users").doc(id).get();
    if (!doc.exists) return null;

    const rawUserData = doc.data();
    const userData = serializeFirestoreData(rawUserData);

    // Ensure default values for fishCoins, level, and nested stats fields
    const processedUserData = {
      id: doc.id,
      ...userData,
      fishCoins: userData.fishCoins || 0,
      level: userData.level || 0,
      stats: {
        postsCount: userData.stats?.postsCount || 0,
        followersCount: userData.stats?.followersCount || 0,
        followingCount: userData.stats?.followingCount || 0,
        contestsJoined: userData.stats?.contestsJoined || 0,
        wins: userData.stats?.wins || 0,
        totalVotesReceived: userData.stats?.totalVotesReceived || 0,
      },
    };
    
    console.log("Processed User data from Firestore (with defaults):", processedUserData); // Log the data here

    return processedUserData;
  } catch (error: any) {
    console.error("Error fetching user by id:", error.message);
    return null;
  }
}

export async function getUserPosts(uid: string) {
  try {
    // We try 'uid' or 'userId' depending on your schema. Based on common patterns, it's often 'uid'
    const snapshot = await db.collection("posts").where("uid", "==", uid).get();
    return snapshot.docs.map(doc => ({ id: doc.id, ...serializeFirestoreData(doc.data()) }));
  } catch (error: any) {
    console.error("Error fetching user posts:", error.message);
    return [];
  }
}

export async function getUserStories(uid: string) {
  try {
    const snapshot = await db.collection("stories").where("uid", "==", uid).get();
    return snapshot.docs.map(doc => ({ id: doc.id, ...serializeFirestoreData(doc.data()) }));
  } catch (error: any) {
    console.error("Error fetching user stories:", error.message);
    return [];
  }
}

export async function getTopProducts() {
  return [
    {
      image: "/images/product/product-01.png",
      name: "Apple Watch Series 7",
      category: "Electronics",
      price: 296,
      sold: 22,
      profit: 45,
    },
  ];
}

export async function getInvoiceTableData() {
  return [
    {
      name: "Free package",
      price: 0.0,
      date: "2023-01-13T18:00:00.000Z",
      status: "Paid",
    },
  ];
}

export async function getTopChannels() {
  return [
    {
      name: "Google",
      visitors: 3456,
      revenues: 4220,
      sales: 3456,
      conversion: 2.59,
      logo: logos.google,
    },
  ];
}
