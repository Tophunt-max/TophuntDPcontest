"use client";

import Breadcrumb from "@/components/Breadcrumbs/Breadcrumb";
import { useState, useEffect } from "react";
import { SplashScreenForm } from "../_components/splash-config";
import { OnboardingForm } from "../_components/onboarding-config";
import { HeaderLogoForm } from "./_components/logo-config";

export default function AppDesignSettingsPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [settings, setSettings] = useState({
    splashImageUrl: "",
    headerLogoUrl: "",
    onboarding: [
      { title: "", description: "", imageUrl: "" },
      { title: "", description: "", imageUrl: "" },
      { title: "", description: "", imageUrl: "" },
    ]
  });

  useEffect(() => {
    fetch("/api/app-settings")
      .then(res => res.json())
      .then(data => {
        if (data) {
            setSettings(prev => ({
                ...prev,
                ...data,
                onboarding: data.onboarding || prev.onboarding
            }));
        }
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
      alert("App design settings updated!");
    } catch (err) {
      alert("Error saving");
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="p-10 text-center text-black dark:text-white">Loading...</div>;

  return (
    <div className="mx-auto max-w-4xl text-black dark:text-white">
      <Breadcrumb pageName="App Design Settings" />
      
      <div className="space-y-10">
        <HeaderLogoForm settings={settings} setSettings={setSettings} />
        
        <SplashScreenForm settings={settings} setSettings={setSettings} />
        
        <OnboardingForm settings={settings} setSettings={setSettings} />

        <div className="sticky bottom-10 z-10 flex justify-end">
            <button 
                onClick={handleSave} 
                disabled={saving} 
                className="bg-primary text-white px-10 py-3 rounded-lg hover:bg-opacity-90 disabled:opacity-50 shadow-2xl border-4 border-white dark:border-dark-2"
            >
            {saving ? "Publishing..." : "PUBLISH DESIGN UPDATES"}
            </button>
        </div>
      </div>
    </div>
  );
}
