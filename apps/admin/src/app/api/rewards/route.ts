import { NextResponse } from "next/server";
import { workerAdmin, forward } from "@/lib/worker";

export async function GET() {
  try {
    const { data } = await forward(await workerAdmin(`/rewards`));
    const stored = data && typeof data === "object" && Object.keys(data).length ? data : null;
    return NextResponse.json(
      stored || {
        xpThreshold: 500,
        xpIncrement: 500,
        dailyLoginReward: 10,
        contestJoinReward: 50,
        matchWinReward: 100,
      },
    );
  } catch (error) {
    console.error("Error fetching rewards settings:", error);
    return NextResponse.json({ error: "Failed to fetch settings" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { data, status } = await forward(await workerAdmin(`/rewards`, { method: "POST", body }));
    return NextResponse.json(data, { status });
  } catch (error) {
    console.error("Error saving rewards settings:", error);
    return NextResponse.json({ error: "Failed to save settings" }, { status: 500 });
  }
}
