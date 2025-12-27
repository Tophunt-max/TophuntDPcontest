"use client";

export interface Report {
  id: string;
  type?: string;
  reason?: string;
  username?: string;
  createdAt?: string;
  [key: string]: any;
}

import Breadcrumb from "@/components/Breadcrumbs/Breadcrumb";
import { useState, useEffect } from "react";

export default function ReportsPage() {
  const [reports, setReports] = useState<Report[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/reports")
      .then(res => res.json())
      .then(data => {
        setReports(data);
        setLoading(false);
      });
  }, []);

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this report record?")) return;
    try {
      const res = await fetch(`/api/reports?id=${id}`, { method: "DELETE" });
      if (res.ok) setReports(reports.filter(r => r.id !== id));
    } catch (err) { alert("Error deleting"); }
  };

  if (loading) return <div className="p-10 text-center text-black dark:text-white">Loading Reports...</div>;

  return (
    <div className="mx-auto max-w-6xl text-black dark:text-white">
      <Breadcrumb pageName="User Reports" />
      <div className="rounded-[10px] bg-white p-6 shadow-1 dark:bg-gray-dark border border-stroke dark:border-dark-3">
        <div className="overflow-x-auto">
          <table className="w-full table-auto">
            <thead>
              <tr className="bg-gray-2 text-left dark:bg-dark-2">
                <th className="px-4 py-4 font-medium">Type</th>
                <th className="px-4 py-4 font-medium">Reason</th>
                <th className="px-4 py-4 font-medium">Reported By</th>
                <th className="px-4 py-4 font-medium">Date</th>
                <th className="px-4 py-4 font-medium text-center">Actions</th>
              </tr>
            </thead>
            <tbody>
              {reports.map((report) => (
                <tr key={report.id} className="border-b border-stroke dark:border-dark-3">
                  <td className="px-4 py-5"><span className="uppercase text-xs font-bold">{report.type || 'N/A'}</span></td>
                  <td className="px-4 py-5 text-sm">{report.reason || 'N/A'}</td>
                  <td className="px-4 py-5 text-sm">@{report.username || 'unknown'}</td>
                  <td className="px-4 py-5 text-sm">{report.createdAt ? report.createdAt.split('T')[0] : 'N/A'}</td>
                  <td className="px-4 py-5 text-center">
                    <button onClick={() => handleDelete(report.id)} className="text-red-500 hover:underline text-xs font-medium">Delete Record</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {reports.length === 0 && <p className="text-center py-10 text-gray-500">No reports found.</p>}
        </div>
      </div>
    </div>
  );
}
