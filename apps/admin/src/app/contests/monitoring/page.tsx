"use client";

import React, { useEffect, useState } from "react";
import Breadcrumb from "@/components/Breadcrumbs/Breadcrumb";
import { db } from "@/lib/firebase/config";
import { collection, query, orderBy, getDocs, limit, Timestamp } from "firebase/firestore";

interface DeviceMatchVote {
  id: string;
  matchId: string;
  deviceId: string;
  count: number;
  updatedAt: Timestamp;
}

const VoteMonitoringPage = () => {
  const [votes, setVotes] = useState<DeviceMatchVote[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchMonitoringData();
  }, []);

  const fetchMonitoringData = async () => {
    try {
      setLoading(true);
      const q = query(
        collection(db, "deviceMatchVotes"),
        orderBy("updatedAt", "desc"),
        limit(100)
      );
      const querySnapshot = await getDocs(q);
      const data = querySnapshot.docs.map((doc) => ({
        id: doc.id,
        ...doc.data(),
      })) as DeviceMatchVote[];
      setVotes(data);
    } catch (error) {
      console.error("Error fetching monitoring data:", error);
    } finally {
      setLoading(false);
    }
  };

  const formatDate = (timestamp: Timestamp) => {
    if (!timestamp || typeof timestamp.seconds === 'undefined') return "N/A";
    return new Date(timestamp.seconds * 1000).toLocaleString();
  };

  const getCountColor = (count: number) => {
    if (count >= 5) return "text-danger bg-red-50";
    if (count >= 3) return "text-warning bg-orange-50";
    return "text-success bg-green-50";
  };

  return (
    <>
      <Breadcrumb pageName="Vote Monitoring" />

      <div className="rounded-sm border border-stroke bg-white px-5 pt-6 pb-2.5 shadow-default dark:border-strokedark dark:bg-boxdark sm:px-7.5 xl:pb-1">
        <div className="mb-4 flex items-center justify-between">
            <h4 className="text-xl font-semibold text-black dark:text-white">
                Suspicious Activity Log
            </h4>
            <button 
                onClick={fetchMonitoringData}
                className="flex items-center gap-2 rounded bg-primary py-2 px-4 font-medium text-white hover:bg-opacity-90"
            >
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="w-5 h-5">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99" />
                </svg>
                Refresh
            </button>
        </div>

        <div className="max-w-full overflow-x-auto">
          <table className="w-full table-auto">
            <thead>
              <tr className="bg-gray-2 text-left dark:bg-meta-4">
                <th className="py-4 px-4 font-medium text-black dark:text-white">
                  Match ID
                </th>
                <th className="py-4 px-4 font-medium text-black dark:text-white">
                  Device ID
                </th>
                <th className="py-4 px-4 font-medium text-black dark:text-white">
                  Votes From Device
                </th>
                <th className="py-4 px-4 font-medium text-black dark:text-white">
                  Last Update
                </th>
                <th className="py-4 px-4 font-medium text-black dark:text-white">
                  Status
                </th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={5} className="text-center py-10">
                    <div className="flex justify-center items-center space-x-2">
                        <div className="h-3 w-3 bg-primary rounded-full animate-bounce [animation-delay:-0.3s]"></div>
                        <div className="h-3 w-3 bg-primary rounded-full animate-bounce [animation-delay:-0.15s]"></div>
                        <div className="h-3 w-3 bg-primary rounded-full animate-bounce"></div>
                    </div>
                  </td>
                </tr>
              ) : votes.length === 0 ? (
                <tr>
                  <td colSpan={5} className="text-center py-10 text-gray-500 font-medium">
                    No multi-vote activity detected yet.
                  </td>
                </tr>
              ) : (
                votes.map((item, key) => (
                  <tr key={key} className="hover:bg-gray-50 dark:hover:bg-meta-4 transition-colors">
                    <td className="border-b border-[#eee] py-5 px-4 dark:border-strokedark">
                      <p className="text-xs font-mono text-black dark:text-white">
                        {item.matchId}
                      </p>
                    </td>
                    <td className="border-b border-[#eee] py-5 px-4 dark:border-strokedark">
                      <p className="text-xs font-mono text-black dark:text-white truncate max-w-[150px]" title={item.deviceId}>
                        {item.deviceId}
                      </p>
                    </td>
                    <td className="border-b border-[#eee] py-5 px-4 dark:border-strokedark">
                      <div className={`inline-flex items-center rounded-full py-1 px-3 text-sm font-bold ${getCountColor(item.count)}`}>
                        {item.count} / 5
                      </div>
                    </td>
                    <td className="border-b border-[#eee] py-5 px-4 dark:border-strokedark">
                      <p className="text-sm text-black dark:text-white">
                        {formatDate(item.updatedAt)}
                      </p>
                    </td>
                    <td className="border-b border-[#eee] py-5 px-4 dark:border-strokedark">
                      {item.count >= 5 ? (
                        <span className="text-xs font-bold text-red-600 bg-red-100 px-2 py-1 rounded">
                          BLOCKED
                        </span>
                      ) : (
                        <span className="text-xs font-medium text-green-600 bg-green-100 px-2 py-1 rounded">
                          ALLOWED
                        </span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <div className="mt-4 p-4 bg-blue-50 dark:bg-dark-2 rounded-lg border border-blue-100 dark:border-dark-3">
            <h5 className="text-sm font-bold text-blue-800 dark:text-blue-300 mb-1">How it works:</h5>
            <p className="text-xs text-blue-700 dark:text-blue-400 leading-relaxed">
                This table tracks how many votes are coming from the same device in a specific match. 
                We allow up to 5 different accounts to vote from one device for the same battle. 
                Once the limit of 5 is reached, any further voting attempts from that device for that specific match will be automatically blocked by the server.
            </p>
        </div>
      </div>
    </>
  );
};

export default VoteMonitoringPage;
