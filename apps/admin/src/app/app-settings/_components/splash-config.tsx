"use client";

import Image from "next/image";
import { ShowcaseSection } from "@/components/Layouts/showcase-section";
import { uploadToFirebaseStorage } from "@/lib/firebase-storage";
import { useState } from "react";

export function SplashScreenForm({ settings, setSettings }: any) {
  const [uploading, setUploading] = useState(false);

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploading(true);
    try {
      const url = await uploadToFirebaseStorage(file, `app/splash_${Date.now()}.png`);
      setSettings({ ...settings, splashImageUrl: url });
      alert("Splash image updated!");
    } catch (err) {
      alert("Upload failed");
    } finally {
      setUploading(false);
    }
  };

  return (
    <ShowcaseSection title="Splash Screen" className="!p-7">
      <div className="flex flex-col md:flex-row gap-8 items-center">
        <div className="relative h-64 w-40 rounded-xl border border-stroke overflow-hidden bg-gray-2 dark:bg-dark-2 flex-shrink-0">
          {settings.splashImageUrl ? (
            <Image src={settings.splashImageUrl} alt="Splash" fill className="object-cover" />
          ) : (
            <div className="flex items-center justify-center h-full text-xs text-gray-500">No Image</div>
          )}
          {uploading && (
            <div className="absolute inset-0 bg-black/40 flex items-center justify-center text-white text-xs">Uploading...</div>
          )}
        </div>
        <div className="flex-1">
          <label className="block mb-2 text-sm font-medium text-black dark:text-white">Update Splash Image</label>
          <input 
            type="file" 
            onChange={handleImageUpload} 
            disabled={uploading}
            className="w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-primary file:text-white hover:file:bg-opacity-90 cursor-pointer disabled:opacity-50" 
          />
          <p className="mt-2 text-xs text-gray-400">Recommended: 1242x2688 px (PNG/JPG)</p>
          {settings.splashImageUrl && (
            <button 
              type="button" 
              onClick={() => setSettings({...settings, splashImageUrl: ""})}
              className="mt-4 text-xs text-red-500 hover:underline"
            >
              Remove Image
            </button>
          )}
        </div>
      </div>
    </ShowcaseSection>
  );
}
