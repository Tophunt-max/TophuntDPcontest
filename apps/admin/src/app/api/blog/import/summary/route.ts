import { NextResponse } from "next/server";
import { workerAdmin, forward } from "@/lib/worker";

// Import-log breakdown by status + missing-image total.
export async function GET() {
  try {
    const { data, status } = await forward(await workerAdmin("/blog/import/summary"));
    return NextResponse.json(data, { status });
  } catch (error) {
    return NextResponse.json({ byStatus: {}, missingImages: 0 }, { status: 200 });
  }
}
