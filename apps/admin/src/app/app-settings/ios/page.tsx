"use client";

import Breadcrumb from "@/components/Breadcrumbs/Breadcrumb";
import { useState, useEffect } from "react";
import { ShowcaseSection } from "@/components/Layouts/showcase-section";
import InputGroup from "@/components/FormElements/InputGroup";

export default function IosSettingsPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [ios, setIos] = useState({
    bundleId: "",
    appStoreUrl: "",
    minVersion: "1.0.0",
    updateRequired: false
  });

  useEffect(() => {
    fetch("/api/app-settings")
      .then(res => res.json())
      .then(data => {
        if (data.iosSettings) setIos(data.iosSettings);
        setLoading(false);
      });
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      await fetch("/api/app-settings", {
        method: "POST",
        body: JSON.stringify({ iosSettings: ios }),
        headers: { "Content-Type": "application/json" }
      });
      alert("iOS settings updated!");
    } catch (err) {
      alert("Error saving");
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="p-10 text-center text-black dark:text-white">Loading...</div>;

  return (
    <div className="mx-auto max-w-4xl text-black dark:text-white">
      <Breadcrumb pageName="iOS Settings" />
      <ShowcaseSection title="iOS Configuration" className="!p-7">
        <div className="space-y-6">
          <InputGroup
            label="Bundle ID"
            type="text"
            placeholder="com.example.app"
            value={ios.bundleId}
            handleChange={(e) => setIos({...ios, bundleId: e.target.value})}
          />
          <InputGroup
            label="App Store URL"
            type="text"
            placeholder="https://apps.apple.com/..."
            value={ios.appStoreUrl}
            handleChange={(e) => setIos({...ios, appStoreUrl: e.target.value})}
          />
          <InputGroup
            label="Minimum Required Version"
            type="text"
            placeholder="1.0.0"
            value={ios.minVersion}
            handleChange={(e) => setIos({...ios, minVersion: e.target.value})}
          />
          <div className="flex items-center justify-between p-4 rounded-lg bg-gray-2 dark:bg-dark-2">
            <div>
              <p className="font-medium">Force Update</p>
              <p className="text-xs text-gray-500">Require users to update to use the app.</p>
            </div>
            <div className="relative inline-block w-12 h-6 transition duration-200 ease-in-out bg-gray-300 rounded-full cursor-pointer">
                <input 
                  type="checkbox" 
                  checked={ios.updateRequired} 
                  onChange={(e) => setIos({...ios, updateRequired: e.target.checked})}
                  className="sr-only" 
                  id="force-update"
                />
                <label 
                  htmlFor="force-update"
                  className={`absolute left-1 top-1 flex h-4 w-4 items-center justify-center rounded-full transition-transform duration-200 ease-in-out ${ios.updateRequired ? 'translate-x-6 bg-primary' : 'bg-white'}`}
                ></label>
            </div>
          </div>
        </div>
        <div className="mt-8 flex justify-end">
          <button onClick={handleSave} disabled={saving} className="bg-primary text-white px-8 py-2 rounded-lg hover:bg-opacity-90 disabled:opacity-50">
            {saving ? "Saving..." : "Save iOS Settings"}
          </button>
        </div>
      </ShowcaseSection>
    </div>
  );
}
