import { db } from "@/lib/firebase/admin";
import { NextResponse } from "next/server";

export async function GET() {
  try {
    const doc = await db.collection("settings").doc("appConfig").get();
    if (!doc.exists) {
      return NextResponse.json({ 
        appName: "TopHunt DP Contest",
        appVersion: "1.0.0",
        maintenanceMode: false,
        supportEmail: "support@tophunt.com",
        authSettings: {
            googleLogin: true,
            facebookLogin: false,
            appleLogin: false
        },
        androidSettings: {
            packageName: "com.tophunt.app",
            playStoreUrl: "",
            minVersion: "1.0.0"
        },
        iosSettings: {
            bundleId: "com.tophunt.app",
            appStoreUrl: "",
            minVersion: "1.0.0"
        }
      });
    }
    return NextResponse.json(doc.data());
  } catch (error) {
    return NextResponse.json({ error: "Failed to fetch settings" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    await db.collection("settings").doc("appConfig").set({
      ...body,
      updatedAt: new Date()
    }, { merge: true });
    
    return NextResponse.json({ message: "Settings updated successfully" });
  } catch (error) {
    return NextResponse.json({ error: "Failed to update settings" }, { status: 500 });
  }
}
