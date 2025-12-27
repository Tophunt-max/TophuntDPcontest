"use client";

import Breadcrumb from "@/components/Breadcrumbs/Breadcrumb";
import { useState, useEffect } from "react";
import { GlobalConfigForm } from "./_components/global-config";

export default function AppSettingsPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [settings, setSettings] = useState({
    appName: "",
    appVersion: "",
    maintenanceMode: false,
    supportEmail: "",
  });

  useEffect(() => {
    fetch("/api/app-settings")
      .then(res => res.json())
      .then(data => {
        if (data) setSettings(data);
        setLoading(false);
      });
  }, []);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await fetch("/api/app-settings", {
        method: "POST",
        body: JSON.stringify(settings),
        headers: { "Content-Type": "application/json" }
      });
      alert("Global settings saved!");
    } catch (err) {
      alert("Error saving settings");
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="p-10 text-center text-black dark:text-white">Loading...</div>;

  return (
    <div className="mx-auto max-w-4xl text-black dark:text-white">
      <Breadcrumb pageName="Global Config" />
      <form onSubmit={handleSave} className="space-y-8">
        <GlobalConfigForm settings={settings} setSettings={setSettings} />
        <div className="flex justify-end">
          <button type="submit" disabled={saving} className="bg-primary text-white px-10 py-3 rounded-lg hover:bg-opacity-90 disabled:opacity-50 shadow-xl">
            {saving ? "Saving..." : "SAVE GLOBAL CONFIG"}
          </button>
        </div>
      </form>
    </div>
  );
}
