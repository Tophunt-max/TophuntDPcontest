"use client";

import Breadcrumb from "@/components/Breadcrumbs/Breadcrumb";
import { useState, useEffect } from "react";
import { BannerConfigForm } from "./_components/banner-config";

export default function BannerSettingsPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [banners, setBanners] = useState<any[]>([]);

  useEffect(() => {
    fetch("/api/app-settings")
      .then(res => res.json())
      .then(data => {
        if (data && data.banners) {
            setBanners(data.banners);
        }
        setLoading(false);
      });
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      await fetch("/api/app-settings", {
        method: "POST",
        body: JSON.stringify({ banners }), // Only update banners field
        headers: { "Content-Type": "application/json" }
      });
      alert("Banner settings updated!");
    } catch (err) {
      alert("Error saving");
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="p-10 text-center text-black dark:text-white">Loading...</div>;

  return (
    <div className="mx-auto max-w-5xl text-black dark:text-white">
      <Breadcrumb pageName="Banner Settings" />
      
      <div className="space-y-8">
        <BannerConfigForm banners={banners} setBanners={setBanners} />

        <div className="flex justify-end sticky bottom-10 z-10">
          <button 
            onClick={handleSave} 
            disabled={saving} 
            className="bg-primary text-white px-10 py-3 rounded-lg hover:bg-opacity-90 disabled:opacity-50 shadow-xl border-4 border-white dark:border-dark-2"
          >
            {saving ? "Publishing..." : "PUBLISH BANNERS"}
          </button>
        </div>
      </div>
    </div>
  );
}
