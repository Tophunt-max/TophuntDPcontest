"use client";

import Image from "next/image";
import { useState } from "react";
import { uploadToR2 } from "@/lib/r2-upload";
import InputGroup from "@/components/FormElements/InputGroup";
import { ShowcaseSection } from "@/components/Layouts/showcase-section";

export function BannerConfigForm({ banners, setBanners }: any) {
  const [uploading, setUploading] = useState(false);
  const [newBanner, setNewBanner] = useState({ imageUrl: "", link: "", title: "" });

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploading(true);
    try {
      const url = await uploadToR2(file, "app/banners");
      setNewBanner({ ...newBanner, imageUrl: url });
    } catch (err) {
      alert("Upload failed");
    } finally {
      setUploading(false);
    }
  };

  const addBanner = () => {
    if (!newBanner.imageUrl) return alert("Please upload an image first");
    setBanners([...banners, newBanner]);
    setNewBanner({ imageUrl: "", link: "", title: "" });
  };

  const removeBanner = (index: number) => {
    const updated = banners.filter((_: any, i: number) => i !== index);
    setBanners(updated);
  };

  return (
    <ShowcaseSection title="Home Page Banners" className="!p-7">
      
      {/* Existing Banners List */}
      <div className="mb-8 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {banners.map((banner: any, index: number) => (
          <div key={index} className="relative group overflow-hidden rounded-lg border border-stroke dark:border-strokedark">
            <div className="relative h-40 w-full bg-gray-2 dark:bg-dark-2">
              <Image src={banner.imageUrl} alt={banner.title} fill className="object-cover" />
            </div>
            <div className="p-3">
              <p className="text-sm font-bold text-black dark:text-white truncate">{banner.title || "No Title"}</p>
              <p className="text-xs text-gray-500 truncate">{banner.link || "No Link"}</p>
            </div>
            <button 
                onClick={() => removeBanner(index)}
                className="absolute top-2 right-2 bg-red-500 text-white rounded-full p-1 opacity-0 group-hover:opacity-100 transition-opacity"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        ))}
      </div>

      {/* Add New Banner Form */}
      <div className="rounded-lg border border-dashed border-stroke bg-gray-50 p-6 dark:border-strokedark dark:bg-boxdark-2">
        <h4 className="mb-4 text-title-xs font-bold text-black dark:text-white">Add New Banner</h4>
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-4">
            <div className="relative h-24 w-40 flex-shrink-0 overflow-hidden rounded border border-stroke bg-white dark:border-strokedark dark:bg-boxdark">
                {newBanner.imageUrl ? (
                    <Image src={newBanner.imageUrl} alt="Preview" fill className="object-cover" />
                ) : (
                    <div className="flex h-full items-center justify-center text-xs text-gray-400">Preview</div>
                )}
                {uploading && <div className="absolute inset-0 flex items-center justify-center bg-black/50 text-xs text-white">Uploading...</div>}
            </div>
            <div className="flex-1">
                <input 
                    type="file" 
                    onChange={handleImageUpload} 
                    className="w-full text-sm file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:bg-primary file:text-white hover:file:bg-opacity-90"
                />
                <p className="mt-1 text-[10px] text-gray-500">Recommended: 800x400px</p>
            </div>
          </div>
          
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <InputGroup
                label="Banner Title (Optional)"
                type="text"
                placeholder="e.g. Mega Contest"
                value={newBanner.title}
                handleChange={(e) => setNewBanner({...newBanner, title: e.target.value})}
            />
            <InputGroup
                label="Link / Action (Optional)"
                type="text"
                placeholder="e.g. /contest/123"
                value={newBanner.link}
                handleChange={(e) => setNewBanner({...newBanner, link: e.target.value})}
            />
          </div>

          <button 
            type="button"
            onClick={addBanner}
            disabled={!newBanner.imageUrl}
            className="mt-2 flex w-full justify-center rounded bg-primary p-3 font-medium text-gray hover:bg-opacity-90 disabled:opacity-50"
          >
            Add to List
          </button>
        </div>
      </div>

    </ShowcaseSection>
  );
}
