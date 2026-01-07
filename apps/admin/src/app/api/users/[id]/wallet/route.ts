import { NextRequest, NextResponse } from "next/server";
import { getFunctions } from "firebase-admin/functions";
import { app } from "@/lib/firebase/admin";

export async function POST(req: NextRequest, context: { params: { id: string } }) {
  try {
    const { id: userId } = context.params;
    const { amount, type } = await req.json();

    if (!userId || typeof amount !== "number" || !["add", "subtract"].includes(type)) {
      return NextResponse.json({ error: "Invalid request parameters." }, { status: 400 });
    }

    const functions = getFunctions(app);
    
    // Ab 'api' function ko call karna hoga with 'adminManageWallet' action
    const apiRouter = functions.taskQueue("api"); // Note: v2 functions use direct calling usually, but from Admin SDK we use taskQueue or https endpoint
    
    // For simplicity and compatibility with consolidated API, we trigger the HTTPS endpoint
    const apiResponse = await fetch(`https://api-7q6m5m5w3q-uc.a.run.app`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: { action: "adminManageWallet", userId, amount, type } })
    });
    
    const result = await apiResponse.json();

    if (result.result && result.result.success) {
      return NextResponse.json({ message: result.result.message, newBalance: result.result.newBalance });
    } else {
      return NextResponse.json({ error: result.error?.message || "Failed to update wallet via Cloud Function." }, { status: 500 });
    }
  } catch (error: any) {
    console.error("Error updating wallet:", error);
    return NextResponse.json({ error: error.message || "Failed to update wallet." }, { status: 500 });
  }
}
