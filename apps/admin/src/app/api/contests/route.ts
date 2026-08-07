import { NextResponse } from "next/server";
import { workerAdmin, forward } from "@/lib/worker";

// List all contests (admin) from the Worker / D1.
export async function GET() {
  try {
    const { data, status } = await forward(await workerAdmin("/contests"));
    return NextResponse.json(data, { status });
  } catch (error) {
    return NextResponse.json([], { status: 200 });
  }
}
