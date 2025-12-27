import { auth, db } from "@/lib/firebase/admin";
import { NextResponse } from "next/server";

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // Await params in Next.js 15+
    const { id } = await params;

    if (!id) {
      return NextResponse.json({ error: "User ID is required" }, { status: 400 });
    }

    // 1. Delete from Firestore (using the db instance connected to 'dpcontest')
    await db.collection("users").doc(id).delete();

    // 2. Delete from Firebase Auth
    try {
      await auth.deleteUser(id);
    } catch (authError) {
      console.error("Error deleting from Auth:", authError);
    }

    return NextResponse.json({ message: "User deleted successfully" });
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
    const body = await request.json();
    const { isBlocked } = body;

    console.log(`Setting isBlocked to ${isBlocked} for user ${id}`);

    if (!id) {
      return NextResponse.json({ error: "User ID is required" }, { status: 400 });
    }

    // Update block status in Firestore (using the db instance connected to 'dpcontest')
    await db.collection("users").doc(id).update({
      isBlocked: !!isBlocked,
      updatedAt: new Date(),
    });

    // Also disable in Firebase Auth
    try {
        await auth.updateUser(id, {
            disabled: !!isBlocked
        });
    } catch (authError) {
        console.warn("Auth update failed (user might not exist in Auth):", authError);
    }

    return NextResponse.json({ 
        message: `User ${isBlocked ? 'blocked' : 'unblocked'} successfully`,
        status: isBlocked 
    });
  } catch (error: any) {
    console.error("Error updating user status:", error);
    return NextResponse.json({ error: error.message || "Failed to update user status" }, { status: 500 });
  }
}
