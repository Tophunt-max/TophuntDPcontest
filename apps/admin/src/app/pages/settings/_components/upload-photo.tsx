"use client";

import { UploadIcon } from "@/assets/icons";
import { ShowcaseSection } from "@/components/Layouts/showcase-section";
import { useAuth } from "@/components/Auth/AuthProvider";
import { useState } from "react";
import { updateProfile } from "firebase/auth";
import { uploadToR2 } from "@/lib/r2-upload";

export function UploadPhotoForm() {
  const { user } = useAuth();
  const [loading, setLoading] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (selectedFile) {
      setFile(selectedFile);
      setPreview(URL.createObjectURL(selectedFile));
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !file) return;
    
    setLoading(true);
    try {
      // Using Cloudflare Worker for upload
      const publicUrl = await uploadToR2(file, 'profiles', user.uid);
      
      await updateProfile(user, { photoURL: publicUrl });
      alert("Profile photo updated successfully!");
      setPreview(null); 
      setFile(null);
    } catch (error: any) {
      alert("Error: " + error.message);
    } finally {
      setLoading(false);
    }
  };

  const currentImg = preview || user?.photoURL;

  return (
    <ShowcaseSection title="Your Photo" className="!p-7">
      <form onSubmit={handleSubmit}>
        <div className="mb-4 flex items-center gap-3">
          <div className="size-14 rounded-full overflow-hidden border border-stroke dark:border-dark-3 bg-gray-100 flex items-center justify-center">
            {currentImg ? (
                <img
                    src={currentImg}
                    alt="Admin"
                    className="size-full object-cover"
                />
            ) : (
                <span className="text-xl font-bold text-gray-400">{(user?.displayName || "A").charAt(0)}</span>
            )}
          </div>

          <div>
            <span className="mb-1.5 font-medium text-dark dark:text-white block text-sm">
              Edit your photo
            </span>
            <span className="flex gap-3">
              <button 
                type="button" 
                onClick={() => { setPreview(null); setFile(null); }}
                className="text-xs text-red-500 hover:underline"
              >
                Reset
              </button>
            </span>
          </div>
        </div>

        <div className="relative mb-5.5 block w-full rounded-xl border border-dashed border-gray-4 bg-gray-2 hover:border-primary dark:border-dark-3 dark:bg-dark-2 dark:hover:border-primary">
          <input
            type="file"
            name="profilePhoto"
            id="profilePhoto"
            accept="image/*"
            onChange={handleFileChange}
            hidden
          />

          <label
            htmlFor="profilePhoto"
            className="flex cursor-pointer flex-col items-center justify-center p-4 sm:py-7.5"
          >
            <div className="flex size-13.5 items-center justify-center rounded-full border border-stroke bg-white dark:border-dark-3 dark:bg-gray-dark">
              <UploadIcon />
            </div>
            <p className="mt-2.5 text-body-sm font-medium">
              <span className="text-primary">Click to upload</span> or drag and drop
            </p>
          </label>
        </div>

        <div className="flex justify-end gap-3">
          <button
            className="flex justify-center rounded-lg border border-stroke px-6 py-[7px] font-medium text-dark hover:shadow-1 dark:border-dark-3 dark:text-white"
            type="button"
          >
            Cancel
          </button>
          <button
            className="flex items-center justify-center rounded-lg bg-primary px-6 py-[7px] font-medium text-white hover:bg-opacity-90 disabled:bg-opacity-50"
            type="submit"
            disabled={loading || !file}
          >
            {loading ? "Saving..." : "Save"}
          </button>
        </div>
      </form>
    </ShowcaseSection>
  );
}
