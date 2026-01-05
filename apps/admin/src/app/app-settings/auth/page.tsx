"use client";

import Breadcrumb from "@/components/Breadcrumbs/Breadcrumb";
import { useState, useEffect } from "react";
import { ShowcaseSection } from "@/components/Layouts/showcase-section";

export default function AuthSettingsPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [authSettings, setAuthSettings] = useState({
    googleLogin: true,
    facebookLogin: true,
    appleLogin: true,
    phoneLogin: true,
    passwordLogin: true,
    emailSignup: true,
  });

  const [legalSettings, setLegalSettings] = useState({
    termsOfService: "https://example.com/terms",
    privacyPolicy: "https://example.com/privacy",
  });

  useEffect(() => {
    fetch("/api/app-settings")
      .then(res => res.json())
      .then(data => {
        if (data.authSettings) {
          setAuthSettings({
            googleLogin: data.authSettings.googleLogin ?? true,
            facebookLogin: data.authSettings.facebookLogin ?? true,
            appleLogin: data.authSettings.appleLogin ?? true,
            phoneLogin: data.authSettings.phoneLogin ?? true,
            passwordLogin: data.authSettings.passwordLogin ?? true,
            emailSignup: data.authSettings.emailSignup ?? true,
          });
        }
        if (data.legalSettings) {
          setLegalSettings({
            termsOfService: data.legalSettings.termsOfService || "https://example.com/terms",
            privacyPolicy: data.legalSettings.privacyPolicy || "https://example.com/privacy",
          });
        }
        setLoading(false);
      });
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      const response = await fetch("/api/app-settings", {
        method: "POST",
        body: JSON.stringify({ authSettings, legalSettings }),
        headers: { "Content-Type": "application/json" }
      });
      if (response.ok) {
        alert("Authentication and Legal settings updated successfully!");
      } else {
        throw new Error("Failed to update");
      }
    } catch (err) {
      alert("Error saving settings");
    } finally {
      setSaving(false);
    }
  };

  const toggleSetting = (key: string) => {
    setAuthSettings(prev => ({
      ...prev,
      //@ts-ignore
      [key]: !prev[key]
    }));
  };

  if (loading) return <div className="p-10 text-center font-medium text-black dark:text-white">Loading configuration...</div>;

  return (
    <div className="mx-auto max-w-4xl">
      <Breadcrumb pageName="Auth & Legal Settings" />
      
      <div className="flex flex-col gap-8">
        <ShowcaseSection title="Login Methods Management" className="!p-7">
          <p className="mb-8 text-base text-body-color dark:text-dark-6">
            Toggle the visibility of login and signup methods on the mobile application.
          </p>
          
          <div className="flex flex-col gap-6">
            <SettingItem 
              label="Google Authentication" 
              enabled={authSettings.googleLogin} 
              onToggle={() => toggleSetting('googleLogin')} 
            />
            <SettingItem 
              label="Facebook Authentication" 
              enabled={authSettings.facebookLogin} 
              onToggle={() => toggleSetting('facebookLogin')} 
            />
            <SettingItem 
              label="Apple Authentication" 
              enabled={authSettings.appleLogin} 
              onToggle={() => toggleSetting('appleLogin')} 
            />
            <SettingItem 
              label="Phone Login (OTP)" 
              enabled={authSettings.phoneLogin} 
              onToggle={() => toggleSetting('phoneLogin')} 
            />
            <SettingItem 
              label="Email & Password Login" 
              enabled={authSettings.passwordLogin} 
              onToggle={() => toggleSetting('passwordLogin')} 
            />
            <SettingItem 
              label="Email Signup (New Accounts)" 
              enabled={authSettings.emailSignup} 
              onToggle={() => toggleSetting('emailSignup')} 
            />
          </div>
        </ShowcaseSection>

        <ShowcaseSection title="Legal Links" className="!p-7">
          <p className="mb-8 text-base text-body-color dark:text-dark-6">
            Configure the URLs for your Terms of Service and Privacy Policy.
          </p>
          
          <div className="flex flex-col gap-6">
            <div>
              <label className="mb-3 block text-sm font-medium text-black dark:text-white">
                Terms of Service URL
              </label>
              <input
                type="text"
                value={legalSettings.termsOfService}
                onChange={(e) => setLegalSettings(prev => ({ ...prev, termsOfService: e.target.value }))}
                placeholder="https://yourdomain.com/terms"
                className="w-full rounded-lg border-[1.5px] border-stroke bg-transparent py-3 px-5 text-black outline-none transition focus:border-primary active:border-primary disabled:cursor-default disabled:bg-whiter dark:border-form-strokedark dark:bg-form-input dark:text-white dark:focus:border-primary"
              />
            </div>

            <div>
              <label className="mb-3 block text-sm font-medium text-black dark:text-white">
                Privacy Policy URL
              </label>
              <input
                type="text"
                value={legalSettings.privacyPolicy}
                onChange={(e) => setLegalSettings(prev => ({ ...prev, privacyPolicy: e.target.value }))}
                placeholder="https://yourdomain.com/privacy"
                className="w-full rounded-lg border-[1.5px] border-stroke bg-transparent py-3 px-5 text-black outline-none transition focus:border-primary active:border-primary disabled:cursor-default disabled:bg-whiter dark:border-form-strokedark dark:bg-form-input dark:text-white dark:focus:border-primary"
              />
            </div>
          </div>
        </ShowcaseSection>

        <div className="flex justify-end mb-10">
          <button 
            onClick={handleSave} 
            disabled={saving} 
            className="inline-flex items-center justify-center rounded-md bg-primary py-4 px-12 text-center text-base font-medium text-white hover:bg-opacity-90 disabled:bg-opacity-50"
          >
            {saving ? "Saving Changes..." : "Save All Configuration"}
          </button>
        </div>
      </div>
    </div>
  );
}

function SettingItem({ label, enabled, onToggle }: { label: string, enabled: boolean, onToggle: () => void }) {
  return (
    <div className="flex items-center justify-between py-2 border-b border-stroke dark:border-dark-3 pb-5">
      <span className="text-lg font-medium text-black dark:text-white">{label}</span>
      <label className="relative inline-flex cursor-pointer items-center">
        <input 
          type="checkbox" 
          className="sr-only" 
          checked={enabled} 
          onChange={onToggle}
        />
        <div className={`h-7 w-12 rounded-full transition-all duration-300 ${enabled ? 'bg-primary' : 'bg-gray-300 dark:bg-dark-4'}`}>
          <div className={`absolute top-1 left-1 h-5 w-5 rounded-full bg-white transition-all duration-300 ${enabled ? 'translate-x-5' : ''}`}></div>
        </div>
      </label>
    </div>
  );
}
