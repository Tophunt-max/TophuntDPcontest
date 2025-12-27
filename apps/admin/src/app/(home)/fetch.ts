import { db } from "@/lib/firebase/admin";

export async function getOverviewData() {
  try {
    const [usersSnap, postsSnap, reportsSnap, supportSnap] = await Promise.all([
      db.collection("users").count().get(),
      db.collection("posts").count().get(),
      db.collection("reports").count().get(),
      db.collection("support_tickets").where("status", "!=", "resolved").count().get()
    ]);

    return {
      views: { value: reportsSnap.data().count, growthRate: 0 },
      profit: { value: supportSnap.data().count, growthRate: 0 },
      products: { value: postsSnap.data().count, growthRate: 0 },
      users: { value: usersSnap.data().count, growthRate: 0 },
    };
  } catch (error) {
    return { views: { value: 0, growthRate: 0 }, profit: { value: 0, growthRate: 0 }, products: { value: 0, growthRate: 0 }, users: { value: 0, growthRate: 0 } };
  }
}

export async function getDeviceStats() {
  try {
    const snapshot = await db.collection("users").limit(1000).get();
    let desktop = 0, mobile = 0, unknown = 0;

    snapshot.docs.forEach(doc => {
      const data = doc.data();
      const platform = data.platform?.toLowerCase() || "";
      if (platform === "web") desktop++;
      else if (platform === "android" || platform === "ios") mobile++;
      else unknown++;
    });

    if (snapshot.empty) {
        return [
            { name: "Web", amount: 40 },
            { name: "Mobile", amount: 45 },
            { name: "Other", amount: 15 }
        ];
    }

    return [
        { name: "Web", amount: desktop },
        { name: "Mobile", amount: mobile },
        { name: "Other", amount: unknown }
    ];
  } catch (e) {
    return [
        { name: "Web", amount: 0 },
        { name: "Mobile", amount: 0 },
        { name: "Other", amount: 0 }
    ];
  }
}

export async function getUserGrowthData() {
  try {
    const usersSnapshot = await db.collection("users").orderBy("createdAt", "desc").limit(500).get();
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const currentMonth = new Date().getMonth();
    const growthMap: { [key: string]: number } = {};
    for (let i = 6; i >= 0; i--) {
        const m = (currentMonth - i + 12) % 12;
        growthMap[months[m]] = 0;
    }
    usersSnapshot.docs.forEach(doc => {
        const date = doc.data().createdAt?.toDate();
        if (date) {
            const monthName = months[date.getMonth()];
            if (growthMap[monthName] !== undefined) growthMap[monthName]++;
        }
    });
    return { categories: Object.keys(growthMap), data: Object.values(growthMap) };
  } catch (e) {
    return { categories: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul"], data: [0, 0, 0, 0, 0, 0, 0] };
  }
}

export async function getChatsData() {
  try {
    const snapshot = await db.collection("support_tickets").limit(5).get();
    return snapshot.docs.map(doc => ({
      name: doc.data().username || "Unknown",
      profile: "/images/user/user-01.png",
      isActive: true,
      lastMessage: {
        content: doc.data().subject || "Support Query",
        type: "text",
        timestamp: doc.data().createdAt?.toDate().toISOString(),
        isRead: doc.data().status === 'resolved',
      },
      unreadCount: doc.data().status === 'resolved' ? 0 : 1,
    }));
  } catch (e) {
    return [];
  }
}
