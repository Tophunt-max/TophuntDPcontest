import { db } from "@/lib/firebase/admin";
import { NextResponse } from "next/server";

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    if (!id) {
      return NextResponse.json({ error: "Contest ID is required" }, { status: 400 });
    }

    await db.collection("contests").doc(id).delete();

    return NextResponse.json({ message: "Contest deleted successfully" });
  } catch (error: any) {
    console.error("Error deleting contest:", error);
    return NextResponse.json({ error: error.message || "Failed to delete contest" }, { status: 500 });
  }
}
