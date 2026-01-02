import { db } from "@/lib/firebase/admin";
import { NextResponse } from "next/server";

export async function GET() {
  try {
    const doc = await db.collection("settings").doc("gamification").get();
    if (!doc.exists) {
      // Default settings if none exist
      return NextResponse.json({
        xpThreshold: 500,
        xpIncrement: 500,
        dailyLoginReward: 10,
        contestJoinReward: 50,
        matchWinReward: 100,
      });
    }
    return NextResponse.json(doc.data());
  } catch (error) {
    console.error("Error fetching rewards settings:", error);
    return NextResponse.json({ error: "Failed to fetch settings" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    await db.collection("settings").doc("gamification").set(body, { merge: true });
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error saving rewards settings:", error);
    return NextResponse.json({ error: "Failed to save settings" }, { status: 500 });
  }
}
