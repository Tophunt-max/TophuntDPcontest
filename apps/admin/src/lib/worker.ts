/**
 * Server-side proxy to the Cloudflare Worker /admin endpoints.
 *
 * The admin Next.js API routes used to talk to Firestore directly via the
 * Firebase Admin SDK. They now forward to the Worker (D1) using a shared
 * server-to-server secret (X-Admin-Secret). Configure:
 *   WORKER_URL           = https://tophunt-api.<subdomain>.workers.dev
 *   ADMIN_PROXY_SECRET   = <same value set on the Worker via `wrangler secret put`>
 */
const WORKER_URL =
  process.env.WORKER_URL || process.env.NEXT_PUBLIC_API_URL || "https://tophunt-api.workers.dev";

export async function workerAdmin(
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<Response> {
  return fetch(`${WORKER_URL}/admin${path}`, {
    method: init?.method || "GET",
    headers: {
      "Content-Type": "application/json",
      "X-Admin-Secret": process.env.ADMIN_PROXY_SECRET || "",
    },
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    cache: "no-store",
  });
}

/** Convenience: forward a Worker response as a Next.js JSON response. */
export async function forward(res: Response) {
  const data = await res.json().catch(() => ({}));
  return { data, status: res.status };
}
