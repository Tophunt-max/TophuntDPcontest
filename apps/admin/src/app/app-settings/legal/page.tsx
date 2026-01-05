"use client";

import Breadcrumb from "@/components/Breadcrumbs/Breadcrumb";
import { useState, useEffect } from "react";

export default function LegalSettingsPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [content, setContent] = useState({
    privacyPolicy: "",
    termsOfService: "",
  });

  useEffect(() => {
    fetch("/api/app-settings")
      .then((res) => res.json())
      .then((data) => {
        if (data && data.legalContent) {
          setContent({
            privacyPolicy: data.legalContent.privacyPolicy || "",
            termsOfService: data.legalContent.termsOfService || "",
          });
        }
        setLoading(false);
      });
  }, []);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const response = await fetch("/api/app-settings", {
        method: "POST",
        body: JSON.stringify({
          legalContent: content,
        }),
        headers: { "Content-Type": "application/json" },
      });

      if (response.ok) {
        alert("Legal content saved successfully!");
      } else {
        throw new Error("Failed to save");
      }
    } catch (err) {
      alert("Error saving legal content");
    } finally {
      setSaving(false);
    }
  };

  if (loading)
    return (
      <div className="p-10 text-center text-black dark:text-white">
        Loading...
      </div>
    );

  return (
    <div className="mx-auto max-w-4xl text-black dark:text-white">
      <Breadcrumb pageName="Legal Content Settings" />
      <div className="rounded-sm border border-stroke bg-white shadow-default dark:border-strokedark dark:bg-boxdark">
        <div className="border-b border-stroke px-6.5 py-4 dark:border-strokedark">
          <h3 className="font-medium text-black dark:text-white">
            Privacy Policy & Terms of Service Content
          </h3>
          <p className="text-sm text-gray-500 mt-1">
            Edit the content that appears on the mobile app's legal pages.
          </p>
        </div>
        <form onSubmit={handleSave} className="p-6.5">
          <div className="mb-6">
            <label className="mb-2.5 block text-black dark:text-white">
              Privacy Policy
            </label>
            <textarea
              rows={15}
              placeholder="Enter Privacy Policy content here..."
              className="w-full rounded border-[1.5px] border-stroke bg-transparent px-5 py-3 text-black outline-none transition focus:border-primary active:border-primary disabled:cursor-default disabled:bg-whiter dark:border-form-strokedark dark:bg-form-input dark:text-white dark:focus:border-primary"
              value={content.privacyPolicy}
              onChange={(e) =>
                setContent({ ...content, privacyPolicy: e.target.value })
              }
            ></textarea>
          </div>

          <div className="mb-6">
            <label className="mb-2.5 block text-black dark:text-white">
              Terms of Service
            </label>
            <textarea
              rows={15}
              placeholder="Enter Terms of Service content here..."
              className="w-full rounded border-[1.5px] border-stroke bg-transparent px-5 py-3 text-black outline-none transition focus:border-primary active:border-primary disabled:cursor-default disabled:bg-whiter dark:border-form-strokedark dark:bg-form-input dark:text-white dark:focus:border-primary"
              value={content.termsOfService}
              onChange={(e) =>
                setContent({ ...content, termsOfService: e.target.value })
              }
            ></textarea>
          </div>

          <div className="flex justify-end">
            <button
              type="submit"
              disabled={saving}
              className="bg-primary text-white px-10 py-3 rounded-lg hover:bg-opacity-90 disabled:opacity-50 shadow-xl"
            >
              {saving ? "Saving..." : "SAVE LEGAL CONTENT"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
