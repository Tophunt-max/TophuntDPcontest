import { NextResponse } from "next/server";
import { workerAdmin, forward } from "@/lib/worker";

// Blog counts for the management page header.
export async function GET() {
  try {
    const { data, status } = await forward(await workerAdmin("/blog/stats"));
    return NextResponse.json(data, { status });
  } catch (error) {
    return NextResponse.json({ total: 0, published: 0, drafts: 0, imported: 0 }, { status: 200 });
  }
}
