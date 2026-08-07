import { NextResponse } from "next/server";
import { workerAdmin, forward } from "@/lib/worker";

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    if (!id) {
      return NextResponse.json({ error: "Contest ID is required" }, { status: 400 });
    }
    const { data, status } = await forward(await workerAdmin(`/contests/${id}`, { method: "DELETE" }));
    return NextResponse.json(data, { status });
  } catch (error: any) {
    console.error("Error deleting contest:", error);
    return NextResponse.json({ error: error.message || "Failed to delete contest" }, { status: 500 });
  }
}
