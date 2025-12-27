import { db } from "@/lib/firebase/admin";
import { NextResponse } from "next/server";

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    await db.collection("posts").doc(id).delete();
    return NextResponse.json({ message: "Post deleted" });
  } catch (error) {
    return NextResponse.json({ error: "Failed" }, { status: 500 });
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { isHidden } = await request.json();
    await db.collection("posts").doc(id).update({
      isHidden: !!isHidden,
      updatedAt: new Date(),
    });
    return NextResponse.json({ message: `Post ${isHidden ? 'hidden' : 'shown'}` });
  } catch (error) {
    return NextResponse.json({ error: "Failed" }, { status: 500 });
  }
}
