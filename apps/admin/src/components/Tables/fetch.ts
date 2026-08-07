import * as logos from "@/assets/logos";
import { workerAdmin, forward } from "@/lib/worker";

// Admin tables now read from the Cloudflare Worker (D1), not Firestore.

async function get<T>(path: string, fallback: T): Promise<T> {
  try {
    const { data, status } = await forward(await workerAdmin(path));
    if (status >= 400) return fallback;
    return data as T;
  } catch {
    return fallback;
  }
}

export async function getUsers() {
  return get<any[]>("/users", []);
}

export async function getPosts() {
  return get<any[]>("/posts", []);
}

export async function getStories() {
  return get<any[]>("/stories", []);
}

export async function getUserById(id: string) {
  return get<any | null>(`/users/${id}`, null);
}

export async function getUserPosts(uid: string) {
  return get<any[]>(`/users/${uid}/posts`, []);
}

export async function getUserStories(uid: string) {
  return get<any[]>(`/users/${uid}/stories`, []);
}

// --- static demo data (unchanged, no backend) ---
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
