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
  type: 'photo' | 'video';
  entryFishCoins: number;
  prizePool: number;
  startDate: Timestamp;
  endDate: Timestamp;
  status: string;
  createdAt: Timestamp;
  bannerUrl?: string; // Optional banner
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

  const getStatusBadge = (status: string, endDate: Timestamp) => {
    const now = new Date();
    const end = endDate && typeof endDate.seconds !== 'undefined' ? new Date(endDate.seconds * 1000) : null;
    
    let displayStatus = status;
    let colorClass = "bg-warning text-warning"; 

    if (end && now > end) {
        displayStatus = "Ended";
        colorClass = "bg-danger text-danger";
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

  const getTypeIcon = (type: string) => {
    return type === 'video' ? (
      <span className="flex items-center gap-1">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5 text-primary">
          <path strokeLinecap="round" strokeLinejoin="round" d="m15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25h-9A2.25 2.25 0 0 0 2.25 7.5v9a2.25 2.25 0 0 0 2.25 2.25Z" />
        </svg>
        Video
      </span>
    ) : (
      <span className="flex items-center gap-1">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5 text-secondary">
          <path strokeLinecap="round" strokeLinejoin="round" d="M6.827 6.175A2.31 2.31 0 0 1 5.186 7.23c-.38.054-.757.112-1.134.175C2.999 7.58 2.25 8.507 2.25 9.574V18a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9.574c0-1.067-.75-1.994-1.802-2.169a47.865 47.865 0 0 0-1.134-.175 2.31 2.31 0 0 1-1.64-1.055l-.822-1.316a2.192 2.192 0 0 0-1.736-1.039 48.774 48.774 0 0 0-5.232 0 2.192 2.192 0 0 0-1.736 1.039l-.821 1.316Z" />
          <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 12.75a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0ZM18.75 10.5h.008v.008h-.008V10.5Z" />
        </svg>
        Photo
      </span>
    );
  }

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
                  Contest
                </th>
                <th className="min-w-[120px] py-4 px-4 font-medium text-black dark:text-white">
                  Type
                </th>
                <th className="min-w-[150px] py-4 px-4 font-medium text-black dark:text-white">
                  Dates
                </th>
                <th className="min-w-[100px] py-4 px-4 font-medium text-black dark:text-white">
                  Stats
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
                  <td colSpan={6} className="text-center py-10">
                    <div className="flex justify-center items-center space-x-2">
                        <div className="h-4 w-4 bg-primary rounded-full animate-bounce [animation-delay:-0.3s]"></div>
                        <div className="h-4 w-4 bg-primary rounded-full animate-bounce [animation-delay:-0.15s]"></div>
                        <div className="h-4 w-4 bg-primary rounded-full animate-bounce"></div>
                    </div>
                  </td>
                </tr>
              ) : contests.length === 0 ? (
                <tr>
                  <td colSpan={6} className="text-center py-10 text-gray-500">
                    No contests found. Start by creating one!
                  </td>
                </tr>
              ) : (
                contests.map((contest, key) => (
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
                                  🖼️
                              </div>
                          )}
                          <div>
                            <h5 className="font-semibold text-black dark:text-white text-lg">
                                {contest.name}
                            </h5>
                            <span className="text-xs text-gray-500 block">ID: {contest.id.slice(0, 8)}...</span>
                          </div>
                      </div>
                    </td>
                    <td className="border-b border-[#eee] py-5 px-4 dark:border-strokedark">
                      <p className="text-black dark:text-white font-medium">
                        {getTypeIcon(contest.type)}
                      </p>
                    </td>
                    <td className="border-b border-[#eee] py-5 px-4 dark:border-strokedark">
                      <div className="flex flex-col text-sm text-black dark:text-white">
                        <span className="text-gray-500 text-xs">Ends on: {formatDate(contest.endDate)}</span>
                        {contest.status === 'live' && <Countdown endDate={contest.endDate} />}
                      </div>
                    </td>
                    <td className="border-b border-[#eee] py-5 px-4 dark:border-strokedark">
                      <div className="flex flex-col gap-1">
                        <span className="text-sm font-medium text-black dark:text-white">
                          🐟 {contest.entryFishCoins} Fee
                        </span>
                        <span className="text-xs text-success font-medium">
                          🏆 {contest.prizePool} Prize
                        </span>
                      </div>
                    </td>
                    <td className="border-b border-[#eee] py-5 px-4 dark:border-strokedark">
                      {getStatusBadge(contest.status, contest.endDate)}
                    </td>
                    <td className="border-b border-[#eee] py-5 px-4 dark:border-strokedark">
                      <div className="flex items-center space-x-3.5">
                        <button className="hover:text-primary transition-colors" title="View Details">
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5">
                                <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 0 1 0-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178Z" />
                                <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
                            </svg>
                        </button>
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
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
};

export default ContestsPage;
