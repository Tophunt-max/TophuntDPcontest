"use client";

import React, { useState } from "react";
import DefaultLayout from "@/components/Layouts/DefaultLayout";
import Breadcrumb from "@/components/Breadcrumbs/Breadcrumb";
import { db } from "@/lib/firebase/config";
import { collection, addDoc, Timestamp } from "firebase/firestore";
import { useRouter } from "next/navigation";
import { uploadToFirebaseStorage } from "@/lib/firebase-storage";

const CreateContest = () => {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [bannerFile, setBannerFile] = useState<File | null>(null);
  const [bannerPreview, setBannerPreview] = useState<string | null>(null);

  const [formData, setFormData] = useState({
    name: "",
    type: "photo",
    description: "",
    rules: "",
    entryFishCoins: 50,
    winningCoins: 500,
    fishCoinsReward: 0,
    minimumVotes: 5,
    joinDurationDays: 7,
    voteDurationDays: 1,
  });

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0];
      setBannerFile(file);
      setBannerPreview(URL.createObjectURL(file));
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    try {
      let bannerUrl = "";
      if (bannerFile) {
        bannerUrl = await uploadToFirebaseStorage(
          bannerFile, 
          `contests/banners/${Date.now()}_${bannerFile.name}`
        );
      }

      const startDate = new Date();
      
      // End Date for the Contest (Join Window)
      const endDate = new Date();
      endDate.setDate(startDate.getDate() + formData.joinDurationDays);

      const prizePool = formData.winningCoins + formData.fishCoinsReward;

      await addDoc(collection(db, "contests"), {
        ...formData,
        bannerUrl, // Save the URL
        prizePool,
        startDate: Timestamp.fromDate(startDate),
        endDate: Timestamp.fromDate(endDate),
        status: "live",
        createdAt: Timestamp.now(),
      });

      router.push("/contests");
    } catch (error: any) {
      console.error("Error creating contest:", error);
      alert("Error: " + error.message);
    } finally {
      setLoading(false);
    }
  };

  const InputField = ({ label, type = "text", value, onChange, placeholder, required = false, className = "" }: any) => (
    <div className={`mb-4.5 ${className}`}>
      <label className="mb-2.5 block text-black dark:text-white font-medium">
        {label} {required && <span className="text-meta-1">*</span>}
      </label>
      <input
        type={type}
        placeholder={placeholder}
        className="w-full rounded border-[1.5px] border-stroke bg-transparent px-5 py-3 text-black outline-none transition focus:border-primary active:border-primary disabled:cursor-default disabled:bg-whiter dark:border-form-strokedark dark:bg-form-input dark:text-white dark:focus:border-primary"
        value={value}
        onChange={onChange}
        required={required}
      />
    </div>
  );

  return (
    <DefaultLayout>
      <Breadcrumb pageName="Create Contest" />

      <div className="grid grid-cols-1 gap-9 sm:grid-cols-2">
        <div className="flex flex-col gap-9">
          {/* Section 1: Basic Details */}
          <div className="rounded-sm border border-stroke bg-white shadow-default dark:border-strokedark dark:bg-boxdark">
            <div className="border-b border-stroke px-6.5 py-4 dark:border-strokedark">
              <h3 className="font-medium text-black dark:text-white text-lg">
                📝 Basic Details
              </h3>
            </div>
            <div className="p-6.5">
              <InputField 
                label="Contest Name" 
                placeholder="e.g. Best Sunset 2024" 
                value={formData.name}
                onChange={(e: any) => setFormData({ ...formData, name: e.target.value })}
                required
              />

              {/* Banner Upload */}
              <div className="mb-4.5">
                <label className="mb-2.5 block text-black dark:text-white font-medium">
                    Contest Banner
                </label>
                <input 
                    type="file" 
                    accept="image/*"
                    onChange={handleFileChange}
                    className="w-full cursor-pointer rounded-lg border-[1.5px] border-stroke bg-transparent font-medium outline-none transition file:mr-5 file:border-collapse file:cursor-pointer file:border-0 file:border-r file:border-solid file:border-stroke file:bg-whiter file:px-5 file:py-3 file:hover:bg-primary file:hover:bg-opacity-10 focus:border-primary active:border-primary disabled:cursor-default disabled:bg-whiter dark:border-form-strokedark dark:bg-form-input dark:file:border-form-strokedark dark:file:bg-white/30 dark:file:text-white dark:focus:border-primary"
                />
                {bannerPreview && (
                    <div className="mt-4">
                        <img src={bannerPreview} alt="Preview" className="h-32 w-full object-cover rounded-md border border-stroke" />
                    </div>
                )}
              </div>

              <div className="mb-4.5">
                <label className="mb-2.5 block text-black dark:text-white font-medium">
                  Contest Type <span className="text-meta-1">*</span>
                </label>
                <div className="relative z-20 bg-transparent dark:bg-form-input">
                  <select
                    className="relative z-20 w-full appearance-none rounded border border-stroke bg-transparent px-5 py-3 outline-none transition focus:border-primary active:border-primary dark:border-form-strokedark dark:bg-form-input dark:focus:border-primary"
                    value={formData.type}
                    onChange={(e) => setFormData({ ...formData, type: e.target.value })}
                  >
                    <option value="photo">📸 Photo Contest</option>
                    <option value="video">🎥 Video Contest</option>
                  </select>
                </div>
              </div>

              <div className="mb-4.5">
                <label className="mb-2.5 block text-black dark:text-white font-medium">
                  Description / Theme
                </label>
                <textarea
                  rows={3}
                  placeholder="Describe what users should upload..."
                  className="w-full rounded border-[1.5px] border-stroke bg-transparent px-5 py-3 text-black outline-none transition focus:border-primary active:border-primary dark:border-form-strokedark dark:bg-form-input dark:text-white dark:focus:border-primary"
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                ></textarea>
              </div>
            </div>
          </div>

          {/* Section 2: Timing Settings */}
          <div className="rounded-sm border border-stroke bg-white shadow-default dark:border-strokedark dark:bg-boxdark">
            <div className="border-b border-stroke px-6.5 py-4 dark:border-strokedark">
              <h3 className="font-medium text-black dark:text-white text-lg">
                ⏱️ Duration Settings
              </h3>
            </div>
            <div className="p-6.5">
                <div className="mb-4.5">
                    <p className="text-sm text-gray-500 mb-3">
                        These settings control how long the contest runs and how long individual battles last.
                    </p>
                </div>
                <div className="flex gap-4">
                    <InputField 
                        label="Contest List (Days)" 
                        type="number"
                        placeholder="7"
                        className="w-1/2"
                        value={formData.joinDurationDays}
                        onChange={(e: any) => setFormData({ ...formData, joinDurationDays: Number(e.target.value) })}
                        required
                    />
                    <InputField 
                        label="Vote Duration (Days)" 
                        type="number"
                        placeholder="1"
                        className="w-1/2"
                        value={formData.voteDurationDays}
                        onChange={(e: any) => setFormData({ ...formData, voteDurationDays: Number(e.target.value) })}
                        required
                    />
                </div>
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-9">
          {/* Section 3: Economy & Rewards */}
          <div className="rounded-sm border border-stroke bg-white shadow-default dark:border-strokedark dark:bg-boxdark">
            <div className="border-b border-stroke px-6.5 py-4 dark:border-strokedark">
              <h3 className="font-medium text-black dark:text-white text-lg">
                💰 Economy & Rewards
              </h3>
            </div>
            <div className="p-6.5">
                <div className="flex gap-4">
                    <InputField 
                        label="Entry Fee (Fish)" 
                        type="number"
                        placeholder="50"
                        className="w-1/2"
                        value={formData.entryFishCoins}
                        onChange={(e: any) => setFormData({ ...formData, entryFishCoins: Number(e.target.value) })}
                        required
                    />
                    <InputField 
                        label="Win Prize (Coins)" 
                        type="number"
                        placeholder="500"
                        className="w-1/2"
                        value={formData.winningCoins}
                        onChange={(e: any) => setFormData({ ...formData, winningCoins: Number(e.target.value) })}
                        required
                    />
                </div>

                <div className="mb-4.5">
                    <InputField 
                        label="Min Votes to Win" 
                        type="number"
                        placeholder="5"
                        value={formData.minimumVotes}
                        onChange={(e: any) => setFormData({ ...formData, minimumVotes: Number(e.target.value) })}
                    />
                </div>

                <div className="mb-4.5">
                    <label className="mb-2.5 block text-black dark:text-white font-medium">
                    Rules
                    </label>
                    <textarea
                    rows={4}
                    placeholder="- No watermarks
- High quality only
- Original content"
                    className="w-full rounded border-[1.5px] border-stroke bg-transparent px-5 py-3 text-black outline-none transition focus:border-primary active:border-primary dark:border-form-strokedark dark:bg-form-input dark:text-white dark:focus:border-primary"
                    value={formData.rules}
                    onChange={(e) => setFormData({ ...formData, rules: e.target.value })}
                    required
                    ></textarea>
                </div>

                <button
                    onClick={handleSubmit}
                    disabled={loading}
                    className="flex w-full justify-center rounded bg-primary p-3 font-medium text-white hover:bg-opacity-90 disabled:opacity-50"
                >
                    {loading ? (
                         <span className="flex items-center gap-2">
                             <span className="animate-spin h-4 w-4 border-2 border-white rounded-full border-t-transparent"></span>
                             Creating...
                         </span>
                    ) : (
                        "🚀 Launch Contest"
                    )}
                </button>
            </div>
          </div>
        </div>
      </div>
    </DefaultLayout>
  );
};

export default CreateContest;
