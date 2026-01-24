"use client";

import React, { useEffect, useState } from "react";
import Breadcrumb from "@/components/Breadcrumbs/Breadcrumb";
import { db } from "@/lib/firebase/config";
import { collection, query, orderBy, getDocs, Timestamp } from "firebase/firestore";
import Link from "next/link";

// Helper for Admin CDN display
const getAdminCdnUrl = (url?: string) => {
    if (!url) return "";
    return url.replace('upload.tophunt.in', 'stream.tophunt.in').replace('media.tophunt.in', 'stream.tophunt.in');
};

interface Contest {
  id: string;
  name: string;
  title: string;
  type: 'photo' | 'video';
  entryFee: number;
  winnerReward: number;
  rewardType?: 'coin' | 'product' | 'both';
  prizeDescription?: string;
  productImageUrl?: string;
  endDate: Timestamp;
  status: string;
  createdAt: Timestamp;
  bannerUrl?: string;
  joinedCount?: number;
  maxParticipants?: number;
}

const Countdown = ({ endDate }: { endDate: Timestamp }) => {
    const [timeLeft, setTimeLeft] = useState("");

    useEffect(() => {
        if (!endDate || typeof endDate.seconds === 'undefined') {
            setTimeLeft("N/A");
            return;
        }

        const updateTimer = () => {
            const now = new Date().getTime();
            const distance = (endDate.seconds * 1000) - now;

            if (distance < 0) {
                setTimeLeft("Ended");
                return;
            }

            const days = Math.floor(distance / (1000 * 60 * 60 * 24));
            const hours = Math.floor((distance % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
            const minutes = Math.floor((distance % (1000 * 60 * 60)) / (1000 * 60));

            if (days > 0) setTimeLeft(`${days}d ${hours}h`);
            else setTimeLeft(`${hours}h ${minutes}m`);
        };

        updateTimer();
        const timer = setInterval(updateTimer, 60000);
        return () => clearInterval(timer);
    }, [endDate]);

    return <span className="text-xs font-semibold text-meta-1 block mt-1">⏳ {timeLeft}</span>;
};

const ContestsPage = () => {
  const [contests, setContests] = useState<Contest[]>([]);
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
      })) as Contest[];
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
        const res = await fetch(`/api/contests/${id}`, {
          method: "DELETE",
        });
        
        if (res.ok) {
          setContests(contests.filter((c) => c.id !== id));
        } else {
          const err = await res.json();
          alert(err.error || "Error deleting contest");
        }
      } catch (error) {
        alert("Error deleting contest");
      }
    }
  };

  const formatDate = (timestamp: Timestamp) => {
    if (!timestamp || typeof timestamp.seconds === 'undefined') return "N/A";
    return new Date(timestamp.seconds * 1000).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  };

  const getStatusBadge = (status: string, endDate: Timestamp, joined: number = 0, max: number = 0) => {
    const now = new Date();
    const end = endDate && typeof endDate.seconds !== 'undefined' ? new Date(endDate.seconds * 1000) : null;
    
    let displayStatus = status;
    let colorClass = "bg-warning text-warning"; 

    if (end && now > end) {
        displayStatus = "Ended";
        colorClass = "bg-danger text-danger";
    } else if (max > 0 && joined >= max) {
        displayStatus = "FULL";
        colorClass = "bg-danger text-danger font-bold";
    } else if (status === "live") {
        displayStatus = "Active";
        colorClass = "bg-success text-success";
    }

    return (
      <span
        className={`inline-flex rounded-full bg-opacity-10 py-1 px-3 text-sm font-medium ${colorClass}`}
      >
        {displayStatus}
      </span>
    );
  };

  return (
    <>
      <Breadcrumb pageName="Manage Contests" />

      <div className="mb-6 flex justify-end">
        <Link
          href="/contests/create"
          className="inline-flex items-center justify-center gap-2.5 rounded-md bg-primary py-4 px-10 text-center font-medium text-white hover:bg-opacity-90 lg:px-8 xl:px-10 transition-all duration-300 shadow-md hover:shadow-lg"
        >
          <span>
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-5 h-5">
              <path fillRule="evenodd" d="M12 3.75a.75.75 0 0 1 .75.75v6.75h6.75a.75.75 0 0 1 0 1.5h-6.75v6.75a.75.75 0 0 1-1.5 0v-6.75H4.5a.75.75 0 0 1 0-1.5h6.75V4.5a.75.75 0 0 1 .75-.75Z" clipRule="evenodd" />
            </svg>
          </span>
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
                  Capacity Progress
                </th>
                <th className="min-w-[150px] py-4 px-4 font-medium text-black dark:text-white">
                  Dates & Rewards
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
                  <td colSpan={5} className="text-center py-10">
                    <div className="flex justify-center items-center space-x-2">
                        <div className="h-4 w-4 bg-primary rounded-full animate-bounce [animation-delay:-0.3s]"></div>
                        <div className="h-4 w-4 bg-primary rounded-full animate-bounce [animation-delay:-0.15s]"></div>
                        <div className="h-4 w-4 bg-primary rounded-full animate-bounce"></div>
                    </div>
                  </td>
                </tr>
              ) : contests.length === 0 ? (
                <tr>
                  <td colSpan={5} className="text-center py-10 text-gray-500">
                    No contests found. Start by creating one!
                  </td>
                </tr>
              ) : (
                contests.map((contest, key) => {
                  const joined = contest.joinedCount || 0;
                  const max = contest.maxParticipants || 100;
                  const percent = Math.min(Math.round((joined / max) * 100), 100);

                  return (
                    <tr key={key} className="hover:bg-gray-50 dark:hover:bg-meta-4 transition-colors">
                      <td className="border-b border-[#eee] py-5 px-4 pl-9 dark:border-strokedark xl:pl-11">
                        <div className="flex items-center gap-4">
                            {contest.bannerUrl ? (
                                <div className="h-12 w-12 rounded-md overflow-hidden flex-shrink-0 border border-stroke">
                                    <img 
                                      src={getAdminCdnUrl(contest.bannerUrl)} 
                                      alt="Banner" 
                                      className="h-full w-full object-cover" 
                                    />
                                </div>
                            ) : (
                                <div className="h-12 w-12 rounded-md bg-gray-2 flex items-center justify-center text-xl flex-shrink-0">
                                    {contest.type === 'video' ? '🎥' : '📸'}
                                </div>
                            )}
                            <div>
                              <h5 className="font-semibold text-black dark:text-white text-md">
                                  {contest.title || contest.name}
                              </h5>
                              <span className="text-xs text-gray-500 block uppercase">{contest.type} contest</span>
                            </div>
                        </div>
                      </td>
                      <td className="border-b border-[#eee] py-5 px-4 dark:border-strokedark">
                        <div className="max-w-[150px]">
                            <div className="flex justify-between mb-1">
                                <span className="text-xs font-medium text-black dark:text-white">{joined}/{max} Joins</span>
                                <span className="text-xs font-medium text-black dark:text-white">{percent}%</span>
                            </div>
                            <div className="w-full bg-gray-200 rounded-full h-1.5 dark:bg-gray-700">
                                <div 
                                    className={`h-1.5 rounded-full ${percent >= 90 ? 'bg-danger' : 'bg-primary'}`} 
                                    style={{ width: `${percent}%` }}
                                ></div>
                            </div>
                        </div>
                      </td>
                      <td className="border-b border-[#eee] py-5 px-4 dark:border-strokedark">
                        <div className="flex flex-col text-sm text-black dark:text-white">
                          <div className="flex flex-col gap-0.5">
                              {contest.rewardType !== 'product' && (
                                  <span className="text-xs font-medium text-success">💰 {contest.winnerReward} Coins</span>
                              )}
                              {(contest.rewardType === 'product' || contest.rewardType === 'both') && (
                                  <div className="flex items-center gap-1.5">
                                      <span className="text-xs font-bold text-warning truncate max-w-[120px]">🎁 {contest.prizeDescription}</span>
                                      {contest.productImageUrl && (
                                          <img src={getAdminCdnUrl(contest.productImageUrl)} className="h-4 w-4 rounded-sm object-cover" alt="Prize" />
                                      )}
                                  </div>
                              )}
                          </div>
                          <span className="text-gray-500 text-xs mt-1">Ends: {formatDate(contest.endDate)}</span>
                        </div>
                      </td>
                      <td className="border-b border-[#eee] py-5 px-4 dark:border-strokedark">
                        {getStatusBadge(contest.status, contest.endDate, joined, max)}
                      </td>
                      <td className="border-b border-[#eee] py-5 px-4 dark:border-strokedark">
                        <div className="flex items-center space-x-3.5">
                          <button 
                            onClick={() => handleDelete(contest.id)}
                            className="hover:text-danger transition-colors"
                            title="Delete Contest"
                          >
                              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5">
                                  <path strokeLinecap="round" strokeLinejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" />
                              </svg>
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
};

export default ContestsPage;
