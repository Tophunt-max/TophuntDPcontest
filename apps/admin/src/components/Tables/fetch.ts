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
        ...serializeFirestoreData(doc.data())\n      }));
    } catch (error: any) {\n      console.error("Error fetching stories:", error.message);\n      return [];\n    }\n}\n\nexport async function getUserById(id: string) {\n  try {\n    const doc = await db.collection("users").doc(id).get();\n    if (!doc.exists) return null;\n\n    const rawUserData = doc.data();\n    const userData = serializeFirestoreData(rawUserData);\n\n    // Ensure default values for Dpcoin, level, and nested stats fields\n    const processedUserData = {\n      id: doc.id,\n      ...userData,\n      Dpcoin: userData.Dpcoin || userData.fishCoins || userData.coins || 0,\n      level: userData.level || 0,\n      stats: {\n        postsCount: userData.stats?.postsCount || 0,\n        followersCount: userData.stats?.followersCount || 0,\n        followingCount: userData.stats?.followingCount || 0,\n        contestsJoined: userData.stats?.contestsJoined || 0,\n        wins: userData.stats?.wins || 0,\n        totalVotesReceived: userData.stats?.totalVotesReceived || 0,\n      },\n    };\n    \n    return processedUserData;\n  } catch (error: any) {\n    console.error("Error fetching user by id:", error.message);\n    return null;\n  }\n}\n\nexport async function getUserPosts(uid: string) {\n  try {\n    const snapshot = await db.collection("posts").where("uid", "==", uid).get();\n    return snapshot.docs.map(doc => ({ id: doc.id, ...serializeFirestoreData(doc.data()) }));\n  } catch (error: any) {\n    console.error("Error fetching user posts:", error.message);\n    return [];\n  }\n}\n\nexport async function getUserStories(uid: string) {\n  try {\n    const snapshot = await db.collection("stories").where("uid", "==", uid).get();\n    return snapshot.docs.map(doc => ({ id: doc.id, ...serializeFirestoreData(doc.data()) }));\n  } catch (error: any) {\n    console.error("Error fetching user stories:", error.message);\n    return [];\n  }\n}\n\nexport async function getTopProducts() {\n  return [\n    {\n      image: "/images/product/product-01.png",\n      name: "Apple Watch Series 7",\n      category: "Electronics",\n      price: 296,\n      sold: 22,\n      profit: 45,\n    },\n  ];\n}\n\nexport async function getInvoiceTableData() {\n  return [\n    {\n      name: "Free package",\n      price: 0.0,\n      date: "2023-01-13T18:00:00.000Z",\n      status: "Paid",\n    },\n  ];\n}\n\nexport async function getTopChannels() {\n  return [\n    {\n      name: "Google",\n      visitors: 3456,\n      revenues: 4220,\n      sales: 3456,\n      conversion: 2.59,\n      logo: logos.google,\n    },\n  ];\n}\n