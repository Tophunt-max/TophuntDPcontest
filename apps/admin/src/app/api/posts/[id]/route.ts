import { NextResponse } from "next/server";
import { workerAdmin, forward } from "@/lib/worker";

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { data, status } = await forward(await workerAdmin(`/posts/${id}`, { method: "DELETE" }));
    return NextResponse.json(data, { status });
  } catch (error) {
    return NextResponse.json({ error: "Failed" }, { status: 500 });
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { isHidden } = await request.json();
    const { data, status } = await forward(
      await workerAdmin(`/posts/${id}`, { method: "PATCH", body: { isHidden } }),
    );
    return NextResponse.json(data, { status });
  } catch (error) {
    return NextResponse.json({ error: "Failed" }, { status: 500 });
  }
}
