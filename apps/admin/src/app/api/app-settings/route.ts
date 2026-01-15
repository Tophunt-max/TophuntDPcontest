import { db } from "@/lib/firebase/admin";
import { NextResponse } from "next/server";

export const revalidate = 300; // Revalidate every 5 minutes

export async function GET() {
  try {
    const doc = await db.collection("settings").doc("appConfig").get();
    
    const host = process.env.NEXT_PUBLIC_APP_URL || "https://tophuntdpcontest.web.app";

    const defaultSettings = { 
      appName: "TopHunt DP Contest",
      appVersion: "1.0.0",
      maintenanceMode: false,
      supportEmail: "support@tophunt.com",
      authSettings: {
          googleLogin: true,
          facebookLogin: true,
          appleLogin: true,
          phoneLogin: true,
          passwordLogin: true,
          emailSignup: true
      },
      legalSettings: {
          termsOfService: `${host}/legal/terms`,
          privacyPolicy: `${host}/legal/privacy`
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
    };

    const data = doc.exists ? (doc.data() || {}) : {};
    
    return NextResponse.json({
      ...defaultSettings,
      ...data,
      authSettings: { ...defaultSettings.authSettings, ...(data.authSettings || {}) },
      legalSettings: { ...defaultSettings.legalSettings, ...(data.legalSettings || {}) }
    }, {
      headers: {
        'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600',
        'X-Content-Type-Options': 'nosniff'
      }
    });
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
