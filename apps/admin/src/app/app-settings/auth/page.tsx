"use client";

import Breadcrumb from "@/components/Breadcrumbs/Breadcrumb";
import { useState, useEffect } from "react";
import { ShowcaseSection } from "@/components/Layouts/showcase-section";

export default function AuthSettingsPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [authSettings, setAuthSettings] = useState({
    googleLogin: true,
    facebookLogin: false,
    appleLogin: false,
    emailSignup: true
  });

  useEffect(() => {
    fetch("/api/app-settings")
      .then(res => res.json())
      .then(data => {
        if (data.authSettings) setAuthSettings(data.authSettings);
        setLoading(false);
      });
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      await fetch("/api/app-settings", {
        method: "POST",
        body: JSON.stringify({ authSettings }),
        headers: { "Content-Type": "application/json" }
      });
      alert("Auth settings updated!");
    } catch (err) {
      alert("Error saving");
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="p-10 text-center text-black dark:text-white">Loading...</div>;

  return (
    <div className="mx-auto max-w-4xl text-black dark:text-white">
      <Breadcrumb pageName="Authentication Settings" />
      <ShowcaseSection title="Social Login Management" className="!p-7">
        <div className="space-y-6">
          {Object.entries(authSettings).map(([key, value]) => (
            <div key={key} className="flex items-center justify-between p-4 rounded-lg bg-gray-2 dark:bg-dark-2">
              <span className="font-medium capitalize">{key.replace(/([A-Z])/g, ' $1')}</span>
              <div className="relative inline-block w-12 h-6 transition duration-200 ease-in-out bg-gray-300 rounded-full cursor-pointer">
                  <input 
                    type="checkbox" 
                    checked={value} 
                    onChange={(e) => setAuthSettings({...authSettings, [key]: e.target.checked})}
                    className="sr-only" 
                    id={`toggle-${key}`}
                  />
                  <label 
                    htmlFor={`toggle-${key}`}
                    className={`absolute left-1 top-1 flex h-4 w-4 items-center justify-center rounded-full transition-transform duration-200 ease-in-out ${value ? 'translate-x-6 bg-primary' : 'bg-white'}`}
                  ></label>
              </div>
            </div>
          ))}
        </div>
        <div className="mt-8 flex justify-end">
          <button onClick={handleSave} disabled={saving} className="bg-primary text-white px-8 py-2 rounded-lg hover:bg-opacity-90 disabled:opacity-50">
            {saving ? "Saving..." : "Save Auth Settings"}
          </button>
        </div>
      </ShowcaseSection>
    </div>
  );
}
