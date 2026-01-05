"use client";

import Image from "next/image";
import { ShowcaseSection } from "@/components/Layouts/showcase-section";
import { uploadToFirebaseStorage } from "@/lib/firebase-storage";
import { useState } from "react";

export function HeaderLogoForm({ settings, setSettings }: any) {
  const [uploading, setUploading] = useState(false);

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploading(true);
    try {
      const url = await uploadToFirebaseStorage(file, `app/header_logo_${Date.now()}.png`);
      setSettings({ ...settings, headerLogoUrl: url });
      alert("Header logo updated!");
    } catch (err) {
      alert("Upload failed");
    } finally {
      setUploading(false);
    }
  };

  return (
    <ShowcaseSection title="Home Header Logo" className="!p-7">
      <div className="flex flex-col md:flex-row gap-8 items-center">
        <div className="relative h-16 w-48 rounded border border-stroke overflow-hidden bg-gray-2 dark:bg-dark-2 flex-shrink-0 flex items-center justify-center p-2">
          {settings.headerLogoUrl ? (
            <Image src={settings.headerLogoUrl} alt="Header Logo" fill className="object-contain p-2" />
          ) : (
            <div className="text-xs text-gray-500 italic font-medium">TopHunt Logo</div>
          )}
          {uploading && (
            <div className="absolute inset-0 bg-black/40 flex items-center justify-center text-white text-[10px]">Uploading...</div>
          )}
        </div>
        <div className="flex-1">
          <label className="block mb-2 text-sm font-medium text-black dark:text-white">Update App Logo (Header)</label>
          <input 
            type="file" 
            onChange={handleImageUpload} 
            disabled={uploading}
            className="w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-primary file:text-white hover:file:bg-opacity-90 cursor-pointer disabled:opacity-50" 
          />
          <p className="mt-2 text-xs text-gray-400">Recommended: Transparent PNG (Height ~80px)</p>
        </div>
      </div>
    </ShowcaseSection>
  );
}
