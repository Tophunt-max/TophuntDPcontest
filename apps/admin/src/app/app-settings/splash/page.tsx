"use client";

import Breadcrumb from "@/components/Breadcrumbs/Breadcrumb";
import { useState, useEffect } from "react";
import { SplashScreenForm } from "../_components/splash-config";

export default function SplashSettingsPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [settings, setSettings] = useState({
    splashImageUrl: ""
  });

  useEffect(() => {
    fetch("/api/app-settings")
      .then(res => res.json())
      .then(data => {
        if (data) setSettings(data);
        setLoading(false);
      });
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      await fetch("/api/app-settings", {
        method: "POST",
        body: JSON.stringify(settings),
        headers: { "Content-Type": "application/json" }
      });
      alert("Splash settings updated!");
    } catch (err) {
      alert("Error saving");
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="p-10 text-center text-black dark:text-white">Loading...</div>;

  return (
    <div className="mx-auto max-w-4xl text-black dark:text-white">
      <Breadcrumb pageName="Splash Screen Settings" />
      <SplashScreenForm settings={settings} setSettings={setSettings} />
      <div className="mt-8 flex justify-end">
        <button onClick={handleSave} disabled={saving} className="bg-primary text-white px-10 py-3 rounded-lg hover:bg-opacity-90 disabled:opacity-50 shadow-xl">
          {saving ? "Publishing..." : "PUBLISH SPLASH UPDATE"}
        </button>
      </div>
    </div>
  );
}
