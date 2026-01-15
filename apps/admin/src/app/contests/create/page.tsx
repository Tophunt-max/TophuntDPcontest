"use client";

import React, { useState } from "react";
import DefaultLayout from "@/components/Layouts/DefaultLayout";
import Breadcrumb from "@/components/Breadcrumbs/Breadcrumb";
import { useRouter } from "next/navigation";
import { uploadToR2 } from "@/lib/r2-upload";
import { callApi } from "@/services/firebase/functions"; 

const CreateContest = () => {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [bannerFile, setBannerFile] = useState<File | null>(null);
  const [bannerPreview, setBannerPreview] = useState<string | null>(null);

  const [formData, setFormData] = useState({
    title: "",
    type: "photo",
    description: "",
    rules: "",
    totalEntryFee: 100, 
    rewardCoins: 150, 
    rewardXP: 100,
    minVotes: 5,
    durationHours: 24,
    autoCancelHours: 24,
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
        // Updated folder to 'contests' to be under admin/contests/
        bannerUrl = await uploadToR2(bannerFile, "contests");
      }

      await callApi('createContestTemplate', {
        ...formData,
        // Ensure numbers are numbers
        totalEntryFee: Number(formData.totalEntryFee),
        rewardCoins: Number(formData.rewardCoins),
        rewardXP: Number(formData.rewardXP),
        minVotes: Number(formData.minVotes),
        durationHours: Number(formData.durationHours),
        autoCancelHours: Number(formData.autoCancelHours),
        bannerUrl
      });

      router.push("/contests");
    } catch (error: any) {
      console.error("Error creating contest:", error);
      alert("Error: " + error.message);
    } finally {
      setLoading(false);
    }
  };

  const InputField = ({ label, type = "text", value, onChange, placeholder, required = false, className = "", helpText = "" }: any) => (
    <div className={`mb-4.5 ${className}`}>
      <label className="mb-2.5 block text-black dark:text-white font-medium">
        {label} {required && <span className="text-meta-1">*</span>}
      </label>
      <input
        type={type}
        placeholder={placeholder}
        className="w-full rounded border-[1.5px] border-stroke bg-transparent px-5 py-3 text-black outline-none transition focus:border-primary active:border-primary dark:border-form-strokedark dark:bg-form-input dark:text-white"
        value={value}
        onChange={onChange}
        required={required}
      />
      {helpText && <p className="mt-1 text-xs text-gray-500">{helpText}</p>}
    </div>
  );

  return (
    <DefaultLayout>
      <Breadcrumb pageName="Create Contest Template" />

      <div className="grid grid-cols-1 gap-9 sm:grid-cols-2">
        <div className="flex flex-col gap-9">
          <div className="rounded-sm border border-stroke bg-white shadow-default dark:border-strokedark dark:bg-boxdark">
            <div className="border-b border-stroke px-6.5 py-4 dark:border-strokedark">
              <h3 className="font-medium text-black dark:text-white text-lg">📝 Contest Details</h3>
            </div>
            <div className="p-6.5">
              <InputField 
                label="Contest Title" 
                placeholder="e.g. Urban Photography Challenge" 
                value={formData.title}
                onChange={(e: any) => setFormData({ ...formData, title: e.target.value })}
                required
              />

              <div className="mb-4.5">
                <label className="mb-2.5 block text-black dark:text-white font-medium">Banner Image</label>
                <input type="file" accept="image/*" onChange={handleFileChange} className="w-full cursor-pointer rounded-lg border-[1.5px] border-stroke bg-transparent font-medium" />
                {bannerPreview && <img src={bannerPreview} className="mt-4 h-32 w-full object-cover rounded-md border" />}
              </div>

              <div className="mb-4.5">
                <label className="mb-2.5 block text-black dark:text-white font-medium">Type</label>
                <select className="w-full rounded border border-stroke bg-transparent px-5 py-3" value={formData.type} onChange={(e: any) => setFormData({ ...formData, type: e.target.value })}>
                  <option value="photo">📸 Photo</option>
                  <option value="video">🎥 Video</option>
                </select>
              </div>

              <InputField label="Description" placeholder="Theme of the contest" value={formData.description} onChange={(e: any) => setFormData({ ...formData, description: e.target.value })} />
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-9">
          <div className="rounded-sm border border-stroke bg-white shadow-default dark:border-strokedark dark:bg-boxdark">
            <div className="border-b border-stroke px-6.5 py-4 dark:border-strokedark">
              <h3 className="font-medium text-black dark:text-white text-lg">💰 Economy & Rules</h3>
            </div>
            <div className="p-6.5">
              <div className="flex gap-4">
                <InputField label="Total Entry Fee (Split)" type="number" className="w-1/2" value={formData.totalEntryFee} onChange={(e: any) => setFormData({ ...formData, totalEntryFee: e.target.value })} required />
                <InputField label="Winner Reward (Coins)" type="number" className="w-1/2" value={formData.rewardCoins} onChange={(e: any) => setFormData({ ...formData, rewardCoins: e.target.value })} required />
              </div>

              <div className="flex gap-4">
                <InputField label="Winner XP" type="number" className="w-1/2" value={formData.rewardXP} onChange={(e: any) => setFormData({ ...formData, rewardXP: e.target.value })} />
                <InputField label="Min Votes to Win" type="number" className="w-1/2" value={formData.minVotes} onChange={(e: any) => setFormData({ ...formData, minVotes: e.target.value })} />
              </div>

              <div className="flex gap-4">
                <InputField 
                    label="Duration (Hours)" 
                    type="number" 
                    className="w-1/2" 
                    value={formData.durationHours} 
                    onChange={(e: any) => setFormData({ ...formData, durationHours: e.target.value })} 
                    helpText="Contest shuru hone ke baad kitni der chalega."
                />
                <InputField 
                    label="Auto-cancel (Hours)" 
                    type="number" 
                    className="w-1/2" 
                    value={formData.autoCancelHours} 
                    onChange={(e: any) => setFormData({ ...formData, autoCancelHours: e.target.value })} 
                    helpText="Agar required players nahi mile toh kab cancel hoga."
                />
              </div>

              <div className="mb-4.5">
                <label className="mb-2.5 block text-black dark:text-white font-medium">Rules</label>
                <textarea rows={3} className="w-full rounded border border-stroke bg-transparent px-5 py-3" value={formData.rules} onChange={(e: any) => setFormData({ ...formData, rules: e.target.value })} />
              </div>

              <button onClick={handleSubmit} disabled={loading} className="w-full rounded bg-primary p-3 font-medium text-white hover:bg-opacity-90 disabled:opacity-50">
                {loading ? "Launching..." : "🚀 Launch Contest Template"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </DefaultLayout>
  );
};

export default CreateContest;
