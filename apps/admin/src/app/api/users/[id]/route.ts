import { NextResponse } from "next/server";
import { workerAdmin, forward } from "@/lib/worker";

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    if (!id) {
      return NextResponse.json({ error: "User ID is required" }, { status: 400 });
    }
    // Worker deletes from D1 + Firebase Auth (Identity Toolkit).
    const { data, status } = await forward(await workerAdmin(`/users/${id}`, { method: "DELETE" }));
    return NextResponse.json(data, { status });
  } catch (error: any) {
    console.error("Error deleting user:", error);
    return NextResponse.json({ error: error.message || "Failed to delete user" }, { status: 500 });
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const { isBlocked } = await request.json();
    if (!id) {
      return NextResponse.json({ error: "User ID is required" }, { status: 400 });
    }
    // Worker updates D1 block status + disables the Firebase Auth user.
    const { data, status } = await forward(
      await workerAdmin(`/users/${id}`, { method: "PATCH", body: { isBlocked } }),
    );
    return NextResponse.json(data, { status });
  } catch (error: any) {
    console.error("Error updating user status:", error);
    return NextResponse.json({ error: error.message || "Failed to update user status" }, { status: 500 });
  }
}
