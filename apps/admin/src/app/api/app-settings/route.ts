import { NextResponse } from "next/server";
import { workerAdmin, forward } from "@/lib/worker";

export async function GET() {
  try {
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
        emailSignup: true,
      },
      legalSettings: {
        termsOfService: `${host}/legal/terms`,
        privacyPolicy: `${host}/legal/privacy`,
      },
      androidSettings: { packageName: "com.tophunt.app", playStoreUrl: "", minVersion: "1.0.0" },
      iosSettings: { bundleId: "com.tophunt.app", appStoreUrl: "", minVersion: "1.0.0" },
    };

    const { data } = await forward(await workerAdmin(`/app-settings`));
    const stored = data && typeof data === "object" ? data : {};

    return NextResponse.json({
      ...defaultSettings,
      ...stored,
      authSettings: { ...defaultSettings.authSettings, ...(stored.authSettings || {}) },
      legalSettings: { ...defaultSettings.legalSettings, ...(stored.legalSettings || {}) },
    });
  } catch (error) {
    return NextResponse.json({ error: "Failed to fetch settings" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { data, status } = await forward(await workerAdmin(`/app-settings`, { method: "POST", body }));
    return NextResponse.json(data, { status });
  } catch (error) {
    return NextResponse.json({ error: "Failed to update settings" }, { status: 500 });
  }
}
