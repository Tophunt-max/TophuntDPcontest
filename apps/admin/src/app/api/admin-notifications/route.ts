import { NextResponse } from "next/server";
import { workerAdmin, forward } from "@/lib/worker";

// Admin activity feed (was Firestore `admin_notifications`) via the Worker / D1.
export async function GET() {
  try {
    const { data, status } = await forward(await workerAdmin("/notifications"));
    return NextResponse.json(data, { status });
  } catch (error) {
    return NextResponse.json([], { status: 200 });
  }
}

// Mark all admin notifications as read.
export async function POST() {
  try {
    const { data, status } = await forward(await workerAdmin("/notifications/read", { method: "POST" }));
    return NextResponse.json(data, { status });
  } catch (error) {
    return NextResponse.json({ success: false }, { status: 500 });
  }
}
