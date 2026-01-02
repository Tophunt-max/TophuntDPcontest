import { NextRequest, NextResponse } from "next/server";
import { getFunctions } from "firebase-admin/functions";
import { app } from "@/lib/firebase/admin"; // Assuming you have an admin Firebase app initialized here

export async function POST(req: NextRequest, context: { params: { id: string } }) {
  try {
    // In a real application, you would verify the admin's authentication here.
    // For this example, we'll assume the admin is authenticated.

    const { id: userId } = context.params;
    const { amount, type } = await req.json();

    if (!userId || typeof amount !== "number" || !["add", "subtract"].includes(type)) {
      return NextResponse.json({ error: "Invalid request parameters." }, { status: 400 });
    }

    const functions = getFunctions(app);
    const adminManageWallet = functions.httpsCallable("adminManageWallet");

    const result = await adminManageWallet({ userId, amount, type });

    // The result.data will contain what the Cloud Function returns
    if ((result.data as any).success) {
      return NextResponse.json({ message: (result.data as any).message, newBalance: (result.data as any).newBalance });
    } else {
      return NextResponse.json({ error: (result.data as any).message || "Failed to update wallet via Cloud Function." }, { status: 500 });
    }
  } catch (error: any) {
    console.error("Error updating wallet:", error);
    return NextResponse.json({ error: error.message || "Failed to update wallet." }, { status: 500 });
  }
}
