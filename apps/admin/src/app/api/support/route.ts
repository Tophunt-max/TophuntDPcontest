import { NextResponse } from "next/server";
import { workerAdmin, forward } from "@/lib/worker";

export async function GET() {
  try {
    const { data, status } = await forward(await workerAdmin(`/support`));
    return NextResponse.json(data, { status });
  } catch (error) {
    return NextResponse.json([]);
  }
}

export async function PATCH(request: Request) {
  try {
    const body = await request.json();
    if (!body?.id) return NextResponse.json({ error: "ID required" }, { status: 400 });
    const { data, status } = await forward(await workerAdmin(`/support`, { method: "PATCH", body }));
    return NextResponse.json(data, { status });
  } catch (error) {
    return NextResponse.json({ error: "Failed" }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    const { data, status } = await forward(
      await workerAdmin(`/support${id ? `?id=${encodeURIComponent(id)}` : ""}`, { method: "DELETE" }),
    );
    return NextResponse.json(data, { status });
  } catch (error) {
    return NextResponse.json({ error: "Failed" }, { status: 500 });
  }
}
