"use client";

import Image from "next/image";
import InputGroup from "@/components/FormElements/InputGroup";
import { ShowcaseSection } from "@/components/Layouts/showcase-section";
import { uploadToFirebaseStorage } from "@/lib/firebase-storage";
import { useState } from "react";

export function OnboardingForm({ settings, setSettings }: any) {
  const [uploading, setUploading] = useState<number | null>(null);

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>, index: number) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploading(index);
    try {
      const url = await uploadToFirebaseStorage(file, `app/onboarding_${index}_${Date.now()}.png`);
      const newOnboarding = [...settings.onboarding];
      newOnboarding[index] = { ...newOnboarding[index], imageUrl: url };
      setSettings({ ...settings, onboarding: newOnboarding });
      alert("Step image updated!");
    } catch (err) {
      alert("Upload failed");
    } finally {
      setUploading(null);
    }
  };

  return (
    <ShowcaseSection title="Onboarding Screens" className="!p-7">
      <div className="space-y-10">
        {settings.onboarding.map((item: any, index: number) => (
          <div key={index} className="flex flex-col md:flex-row gap-6 border-b border-stroke pb-8 last:border-0 dark:border-dark-3">
            <div className="relative h-48 w-32 rounded-lg border border-stroke overflow-hidden bg-gray-2 flex-shrink-0 dark:bg-dark-2">
              {item.imageUrl ? (
                <Image src={item.imageUrl} alt={`Step ${index+1}`} fill className="object-cover" />
              ) : <div className="flex items-center justify-center h-full text-xs text-gray-400">Step {index+1}</div>}
              {uploading === index && (
                <div className="absolute inset-0 bg-black/40 flex items-center justify-center text-white text-[10px]">Uploading...</div>
              )}
            </div>
            <div className="flex-1 space-y-4">
              <InputGroup
                label={`Step ${index+1} Title`}
                type="text"
                placeholder="Enter Title"
                value={item.title}
                handleChange={(e) => {
                  const newOnboarding = [...settings.onboarding];
                  newOnboarding[index].title = e.target.value;
                  setSettings({...settings, onboarding: newOnboarding});
                }}
              />
              <div>
                <label className="text-body-sm font-medium text-dark dark:text-white">Update Image</label>
                <input 
                  type="file" 
                  onChange={(e) => handleImageUpload(e, index)} 
                  disabled={uploading !== null}
                  className="mt-2 w-full text-xs text-gray-500 file:mr-4 file:py-1.5 file:px-3 file:rounded-full file:border-0 file:bg-primary/10 file:text-primary hover:file:bg-primary/20 cursor-pointer disabled:opacity-50" 
                />
              </div>
            </div>
          </div>
        ))}
      </div>
    </ShowcaseSection>
  );
}
