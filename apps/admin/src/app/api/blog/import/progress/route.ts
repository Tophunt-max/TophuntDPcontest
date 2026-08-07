import { NextResponse } from "next/server";
import { workerAdmin, forward } from "@/lib/worker";

// Live import job state (fed by the importer script).
export async function GET() {
  try {
    const { data, status } = await forward(await workerAdmin("/blog/import/progress"));
    return NextResponse.json(data, { status });
  } catch (error) {
    return NextResponse.json(null, { status: 200 });
  }
}
