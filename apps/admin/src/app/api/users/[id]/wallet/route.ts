import { NextRequest, NextResponse } from "next/server";
import { workerAdmin, forward } from "@/lib/worker";

export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const { id: userId } = await context.params;
    const { amount, type } = await req.json();

    if (!userId || typeof amount !== "number" || !["add", "subtract"].includes(type)) {
      return NextResponse.json({ error: "Invalid request parameters." }, { status: 400 });
    }

    // Was a fetch to the Cloud Function; now the Worker manages the wallet in D1.
    const { data, status } = await forward(
      await workerAdmin(`/users/${userId}/wallet`, { method: "POST", body: { amount, type } }),
    );
    if (status >= 400) {
      return NextResponse.json({ error: data?.error?.message || "Failed to update wallet." }, { status });
    }
    return NextResponse.json({ message: data.message, newBalance: data.newBalance });
  } catch (error: any) {
    console.error("Error updating wallet:", error);
    return NextResponse.json({ error: error.message || "Failed to update wallet." }, { status: 500 });
  }
}
