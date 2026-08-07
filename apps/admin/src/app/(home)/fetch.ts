import { workerAdmin, forward } from "@/lib/worker";

// Dashboard data now comes from the Cloudflare Worker (D1), not Firestore.

export async function getOverviewData() {
  try {
    const { data } = await forward(await workerAdmin("/overview"));
    return {
      views: { value: data.reports ?? 0, growthRate: 0 },
      profit: { value: data.support ?? 0, growthRate: 0 },
      products: { value: data.posts ?? 0, growthRate: 0 },
      users: { value: data.users ?? 0, growthRate: 0 },
    };
  } catch (error) {
    return {
      views: { value: 0, growthRate: 0 },
      profit: { value: 0, growthRate: 0 },
      products: { value: 0, growthRate: 0 },
      users: { value: 0, growthRate: 0 },
    };
  }
}

export async function getDeviceStats() {
  try {
    const { data } = await forward(await workerAdmin("/device-stats"));
    return [
      { name: "Web", amount: data.web ?? 0 },
      { name: "Mobile", amount: data.mobile ?? 0 },
      { name: "Other", amount: data.other ?? 0 },
    ];
  } catch (e) {
    return [
      { name: "Web", amount: 0 },
      { name: "Mobile", amount: 0 },
      { name: "Other", amount: 0 },
    ];
  }
}

export async function getUserGrowthData() {
  try {
    const { data } = await forward(await workerAdmin("/user-growth"));
    return { categories: data.categories || [], data: data.data || [] };
  } catch (e) {
    return { categories: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul"], data: [0, 0, 0, 0, 0, 0, 0] };
  }
}

export async function getChatsData() {
  try {
    const { data } = await forward(await workerAdmin("/recent-tickets"));
    return (data || []).map((t: any) => ({
      name: t.username || t.userId || "Unknown",
      profile: "/images/user/user-01.png",
      isActive: true,
      lastMessage: {
        content: t.subject || "Support Query",
        type: "text",
        timestamp: t.createdAt,
        isRead: t.status === "resolved",
      },
      unreadCount: t.status === "resolved" ? 0 : 1,
    }));
  } catch (e) {
    return [];
  }
}
