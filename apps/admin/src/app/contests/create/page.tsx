"use client";

import React, { useState } from "react";
import DefaultLayout from "@/components/Layouts/DefaultLayout";
import Breadcrumb from "@/components/Breadcrumbs/Breadcrumb";
import { db } from "@/lib/firebase/config"; // Assuming this exists
import { collection, addDoc, Timestamp } from "firebase/firestore";
import { useRouter } from "next/navigation";

const CreateContest = () => {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  const [formData, setFormData] = useState({
    name: "",
    type: "photo",
    rules: "",
    entryFishCoins: 100,
    winningCoins: 500,
    fishCoinsReward: 50,
    minimumVotes: 10,
    durationDays: 7,
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    try {
      const startDate = new Date();
      const endDate = new Date();
      endDate.setDate(startDate.getDate() + formData.durationDays);

      await addDoc(collection(db, "contests"), {
        ...formData,
        startDate: Timestamp.fromDate(startDate),
        endDate: Timestamp.fromDate(endDate),
        status: "live",
        createdAt: Timestamp.now(),
      });

      alert("Contest Created Successfully!");
      router.push("/contests");
    } catch (error: any) {
      console.error("Error creating contest:", error);
      alert("Error: " + error.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <DefaultLayout>
      <Breadcrumb pageName="Create Contest" />

      <div className="flex flex-col gap-9">
        <div className="rounded-sm border border-stroke bg-white shadow-default dark:border-strokedark dark:bg-boxdark">
          <div className="border-b border-stroke px-6.5 py-4 dark:border-strokedark">
            <h3 className="font-medium text-black dark:text-white">
              Launch New Photo/Video Contest
            </h3>
          </div>
          <form onSubmit={handleSubmit}>
            <div className="p-6.5">
              <div className="mb-4.5">
                <label className="mb-2.5 block text-black dark:text-white">
                  Contest Name
                </label>
                <input
                  type="text"
                  placeholder="Enter contest name"
                  className="w-full rounded border-[1.5px] border-stroke bg-transparent px-5 py-3 text-black outline-none transition focus:border-primary active:border-primary disabled:cursor-default disabled:bg-whiter dark:border-form-strokedark dark:bg-form-input dark:text-white dark:focus:border-primary"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  required
                />
              </div>

              <div className="mb-4.5">
                <label className="mb-2.5 block text-black dark:text-white">
                  Contest Type
                </label>
                <div className="relative z-20 bg-transparent dark:bg-form-input">
                  <select
                    className="relative z-20 w-full appearance-none rounded border border-stroke bg-transparent px-5 py-3 outline-none transition focus:border-primary active:border-primary dark:border-form-strokedark dark:bg-form-input dark:focus:border-primary"
                    value={formData.type}
                    onChange={(e) => setFormData({ ...formData, type: e.target.value })}
                  >
                    <option value="photo">Photo Contest</option>
                    <option value="video">Video Contest</option>
                  </select>
                </div>
              </div>

              <div className="mb-4.5 flex flex-col gap-6 xl:flex-row">
                <div className="w-full xl:w-1/2">
                  <label className="mb-2.5 block text-black dark:text-white">
                    Entry Fee (Fish Coins)
                  </label>
                  <input
                    type="number"
                    className="w-full rounded border-[1.5px] border-stroke bg-transparent px-5 py-3 text-black outline-none transition focus:border-primary active:border-primary dark:border-form-strokedark dark:bg-form-input dark:text-white dark:focus:border-primary"
                    value={formData.entryFishCoins}
                    onChange={(e) => setFormData({ ...formData, entryFishCoins: parseInt(e.target.value) })}
                  />
                </div>

                <div className="w-full xl:w-1/2">
                  <label className="mb-2.5 block text-black dark:text-white">
                    Winning Prize (Coins)
                  </label>
                  <input
                    type="number"
                    className="w-full rounded border-[1.5px] border-stroke bg-transparent px-5 py-3 text-black outline-none transition focus:border-primary active:border-primary dark:border-form-strokedark dark:bg-form-input dark:text-white dark:focus:border-primary"
                    value={formData.winningCoins}
                    onChange={(e) => setFormData({ ...formData, winningCoins: parseInt(e.target.value) })}
                  />
                </div>
              </div>

              <div className="mb-6">
                <label className="mb-2.5 block text-black dark:text-white">
                  Contest Rules
                </label>
                <textarea
                  rows={4}
                  placeholder="Type rules here"
                  className="w-full rounded border-[1.5px] border-stroke bg-transparent px-5 py-3 text-black outline-none transition focus:border-primary active:border-primary dark:border-form-strokedark dark:bg-form-input dark:text-white dark:focus:border-primary"
                  value={formData.rules}
                  onChange={(e) => setFormData({ ...formData, rules: e.target.value })}
                  required
                ></textarea>
              </div>

              <button
                type="submit"
                disabled={loading}
                className="flex w-full justify-center rounded bg-primary p-3 font-medium text-gray hover:bg-opacity-90"
              >
                {loading ? "Creating..." : "Launch Contest"}
              </button>
            </div>
          </form>
        </div>
      </div>
    </DefaultLayout>
  );
};

export default CreateContest;
