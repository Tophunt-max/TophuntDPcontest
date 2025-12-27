"use client";

import React, { useEffect, useState } from "react";
import DefaultLayout from "@/components/Layouts/DefaultLayout";
import Breadcrumb from "@/components/Breadcrumbs/Breadcrumb";
import { db } from "@/lib/firebase/config";
import { collection, query, orderBy, getDocs, deleteDoc, doc } from "firebase/firestore";
import Link from "next/link";

const ContestsPage = () => {
  const [contests, setContests] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchContests();
  }, []);

  const fetchContests = async () => {
    try {
      const q = query(collection(db, "contests"), orderBy("createdAt", "desc"));
      const querySnapshot = await getDocs(q);
      const data = querySnapshot.docs.map((doc) => ({
        id: doc.id,
        ...doc.data(),
      }));
      setContests(data);
    } catch (error) {
      console.error("Error fetching contests:", error);
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (confirm("Are you sure you want to delete this contest?")) {
      try {
        await deleteDoc(doc(db, "contests", id));
        setContests(contests.filter((c) => c.id !== id));
        alert("Contest Deleted");
      } catch (error) {
        alert("Error deleting contest");
      }
    }
  };

  return (
    <DefaultLayout>
      <Breadcrumb pageName="Manage Contests" />

      <div className="mb-6 flex justify-end">
        <Link
          href="/contests/create"
          className="inline-flex items-center justify-center rounded-md bg-primary py-3 px-10 text-center font-medium text-white hover:bg-opacity-90 lg:px-8 xl:px-10"
        >
          Create New Contest
        </Link>
      </div>

      <div className="rounded-sm border border-stroke bg-white px-5 pt-6 pb-2.5 shadow-default dark:border-strokedark dark:bg-boxdark sm:px-7.5 xl:pb-1">
        <div className="max-w-full overflow-x-auto">
          <table className="w-full table-auto">
            <thead>
              <tr className="bg-gray-2 text-left dark:bg-meta-4">
                <th className="min-w-[220px] py-4 px-4 font-medium text-black dark:text-white xl:pl-11">
                  Contest Name
                </th>
                <th className="min-w-[150px] py-4 px-4 font-medium text-black dark:text-white">
                  Type
                </th>
                <th className="min-w-[120px] py-4 px-4 font-medium text-black dark:text-white">
                  Entry Fee
                </th>
                <th className="min-w-[120px] py-4 px-4 font-medium text-black dark:text-white">
                  Status
                </th>
                <th className="py-4 px-4 font-medium text-black dark:text-white">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={5} className="text-center py-5">Loading Contests...</td>
                </tr>
              ) : contests.length === 0 ? (
                <tr>
                  <td colSpan={5} className="text-center py-5">No contests found.</td>
                </tr>
              ) : (
                contests.map((contest, key) => (
                  <tr key={key}>
                    <td className="border-b border-[#eee] py-5 px-4 pl-9 dark:border-strokedark xl:pl-11">
                      <h5 className="font-medium text-black dark:text-white">
                        {contest.name}
                      </h5>
                    </td>
                    <td className="border-b border-[#eee] py-5 px-4 dark:border-strokedark">
                      <p className="text-black dark:text-white uppercase">
                        {contest.type}
                      </p>
                    </td>
                    <td className="border-b border-[#eee] py-5 px-4 dark:border-strokedark">
                      <p className="text-black dark:text-white">
                        {contest.entryFishCoins} Fish
                      </p>
                    </td>
                    <td className="border-b border-[#eee] py-5 px-4 dark:border-strokedark">
                      <p
                        className={`inline-flex rounded-full bg-opacity-10 py-1 px-3 text-sm font-medium ${
                          contest.status === "live"
                            ? "bg-success text-success"
                            : "bg-warning text-warning"
                        }`}
                      >
                        {contest.status}
                      </p>
                    </td>
                    <td className="border-b border-[#eee] py-5 px-4 dark:border-strokedark">
                      <div className="flex items-center space-x-3.5">
                        <button 
                          onClick={() => handleDelete(contest.id)}
                          className="hover:text-danger"
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </DefaultLayout>
  );
};

export default ContestsPage;
