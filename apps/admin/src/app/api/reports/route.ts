import { NextResponse } from "next/server";
import { workerAdmin, forward } from "@/lib/worker";

export async function GET() {
  try {
    const { data, status } = await forward(await workerAdmin(`/reports`));
    return NextResponse.json(data, { status });
  } catch (error) {
    return NextResponse.json([]);
  }
}

export async function DELETE(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    const { data, status } = await forward(
      await workerAdmin(`/reports${id ? `?id=${encodeURIComponent(id)}` : ""}`, { method: "DELETE" }),
    );
    return NextResponse.json(data, { status });
  } catch (error) {
    return NextResponse.json({ error: "Failed" }, { status: 500 });
  }
}
