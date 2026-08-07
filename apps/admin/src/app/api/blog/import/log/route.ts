import { NextResponse } from "next/server";
import { workerAdmin, forward } from "@/lib/worker";

// Import log rows, optionally filtered by ?status=.
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const status = searchParams.get("status");
    const limit = searchParams.get("limit") || "100";
    const qs = new URLSearchParams({ limit });
    if (status) qs.set("status", status);
    const { data, status: code } = await forward(await workerAdmin(`/blog/import/log?${qs.toString()}`));
    return NextResponse.json(data, { status: code });
  } catch (error) {
    return NextResponse.json([], { status: 200 });
  }
}
