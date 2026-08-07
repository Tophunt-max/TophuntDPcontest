import { NextResponse } from "next/server";
import { workerAdmin, forward } from "@/lib/worker";

// Requeue failed rows (set status -> pending) so the next importer run retries.
export async function POST() {
  try {
    const { data, status } = await forward(await workerAdmin("/blog/import/retry-failed", { method: "POST" }));
    return NextResponse.json(data, { status });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || "Failed to requeue" }, { status: 500 });
  }
}
