// Shared helper for admin CLI scripts. Talks to the Cloudflare Worker's
// /admin endpoints (D1-backed) using the server-to-server ADMIN_PROXY_SECRET.
// No firebase-admin, no Firestore.
//
// Env required (put in apps/admin/.env.local or export before running):
//   WORKER_URL          e.g. https://tophunt-api.<subdomain>.workers.dev
//   ADMIN_PROXY_SECRET  same value set on the Worker via `wrangler secret put`
import fs from "node:fs";
import path from "node:path";

// Lightweight .env.local loader (no dotenv dependency).
function loadEnv() {
  const envPath = path.join(process.cwd(), ".env.local");
  const alt = path.join(path.dirname(new URL(import.meta.url).pathname), "..", ".env.local");
  const file = fs.existsSync(envPath) ? envPath : fs.existsSync(alt) ? alt : null;
  if (!file) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
loadEnv();

const WORKER_URL = process.env.WORKER_URL || process.env.NEXT_PUBLIC_API_URL;
const SECRET = process.env.ADMIN_PROXY_SECRET;

if (!WORKER_URL || !SECRET) {
  console.error("Missing WORKER_URL or ADMIN_PROXY_SECRET (set them in apps/admin/.env.local).");
  process.exit(1);
}

export async function adminApi(path, { method = "GET", body } = {}) {
  const res = await fetch(`${WORKER_URL}/admin${path}`, {
    method,
    headers: { "Content-Type": "application/json", "X-Admin-Secret": SECRET },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error?.message || `Request failed (${res.status}) for ${path}`);
  }
  return data;
}
