"use client";

import React, { useEffect, useState } from "react";
import Breadcrumb from "@/components/Breadcrumbs/Breadcrumb";
import { db } from "@/lib/firebase/config";
import { collection, query, orderBy, getDocs, doc, updateDoc, Timestamp } from "firebase/firestore";

interface PrizeClaim {
  id: string;
  uid: string;
  contestTitle: string;
  prizeName: string;
  shippingInfo: {
    fullName: string;
    phone: string;
    address: string;
    city: string;
    state: string;
    pincode: string;
    submittedAt: Timestamp;
  };
  status: 'pending' | 'processed' | 'shipped' | 'delivered';
  trackingId?: string;
  carrier?: string;
}

const PrizeClaimsPage = () => {
  const [claims, setClaims] = useState<PrizeClaim[]>([]);
  const [loading, setLoading] = useState(true);
  const [updatingId, setUpdatingId] = useState<string | null>(null);

  useEffect(() => {
    fetchClaims();
  }, []);

  const fetchClaims = async () => {
    try {
      setLoading(true);
      const q = query(collection(db, "prizeClaims"), orderBy("updatedAt", "desc"));
      const querySnapshot = await getDocs(q);
      const data = querySnapshot.docs.map((doc) => ({
        id: doc.id,
        ...doc.data(),
      })) as PrizeClaim[];
      setClaims(data);
    } catch (error) {
      console.error("Error fetching claims:", error);
    } finally {
      setLoading(false);
    }
  };

  const updateStatus = async (id: string, newStatus: string, trackingInfo?: { trackingId: string, carrier: string }) => {
    setUpdatingId(id);
    try {
      const claimRef = doc(db, "prizeClaims", id);
      const updates: any = { 
        status: newStatus, 
        updatedAt: Timestamp.now() 
      };
      
      if (trackingInfo) {
        updates.trackingId = trackingInfo.trackingId;
        updates.carrier = trackingInfo.carrier;
      }

      await updateDoc(claimRef, updates);
      
      // Update local state
      setClaims(claims.map(c => c.id === id ? { ...c, ...updates } : c));
      alert("Status updated successfully!");
    } catch (error) {
      alert("Error updating status");
    } finally {
      setUpdatingId(null);
    }
  };

  const handleShip = (id: string) => {
    const tid = prompt("Enter Tracking ID (e.g. BlueDart 12345):");
    if (!tid) return;
    updateStatus(id, 'shipped', { trackingId: tid, carrier: 'standard' });
  };

  const getStatusColor = (status: string) => {
    switch (status) {
        case 'pending': return 'text-warning bg-orange-50';
        case 'shipped': return 'text-primary bg-blue-50';
        case 'delivered': return 'text-success bg-green-50';
        default: return 'text-gray-500 bg-gray-50';
    }
  };

  return (
    <>
      <Breadcrumb pageName="Prize Claims Management" />

      <div className="rounded-sm border border-stroke bg-white px-5 pt-6 pb-2.5 shadow-default dark:border-strokedark dark:bg-boxdark sm:px-7.5 xl:pb-1">
        <div className="mb-4 flex items-center justify-between">
            <h4 className="text-xl font-semibold text-black dark:text-white">
                Pending & Processed Deliveries
            </h4>
            <button onClick={fetchClaims} className="text-primary hover:underline text-sm font-medium">Refresh List</button>
        </div>

        <div className="max-w-full overflow-x-auto">
          <table className="w-full table-auto">
            <thead>
              <tr className="bg-gray-2 text-left dark:bg-meta-4">
                <th className="py-4 px-4 font-medium text-black dark:text-white min-w-[150px]">
                  Winner & Contest
                </th>
                <th className="py-4 px-4 font-medium text-black dark:text-white min-w-[250px]">
                  Shipping Address
                </th>
                <th className="py-4 px-4 font-medium text-black dark:text-white">
                  Prize
                </th>
                <th className="py-4 px-4 font-medium text-black dark:text-white">
                  Status
                </th>
                <th className="py-4 px-4 font-medium text-black dark:text-white">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={5} className="text-center py-10">Loading claims...</td></tr>
              ) : claims.length === 0 ? (
                <tr><td colSpan={5} className="text-center py-10 text-gray-500 font-medium">No prize claims found.</td></tr>
              ) : (
                claims.map((claim, key) => (
                  <tr key={key} className="hover:bg-gray-50 dark:hover:bg-meta-4 transition-colors">
                    <td className="border-b border-[#eee] py-5 px-4 dark:border-strokedark">
                      <p className="font-bold text-black dark:text-white">{claim.shippingInfo.fullName}</p>
                      <p className="text-xs text-gray-500">{claim.contestTitle}</p>
                    </td>
                    <td className="border-b border-[#eee] py-5 px-4 dark:border-strokedark">
                      <p className="text-sm text-black dark:text-white leading-relaxed">
                        {claim.shippingInfo.address}, {claim.shippingInfo.city}, {claim.shippingInfo.state} - <b>{claim.shippingInfo.pincode}</b>
                      </p>
                      <p className="text-xs font-bold text-primary mt-1">📞 {claim.shippingInfo.phone}</p>
                    </td>
                    <td className="border-b border-[#eee] py-5 px-4 dark:border-strokedark">
                      <span className="text-sm font-medium text-meta-3">🎁 {claim.prizeName}</span>
                    </td>
                    <td className="border-b border-[#eee] py-5 px-4 dark:border-strokedark">
                      <div className={`inline-flex rounded-full py-1 px-3 text-xs font-bold uppercase ${getStatusColor(claim.status)}`}>
                        {claim.status}
                      </div>
                      {claim.trackingId && <p className="text-[10px] mt-1 text-gray-500 font-mono">ID: {claim.trackingId}</p>}
                    </td>
                    <td className="border-b border-[#eee] py-5 px-4 dark:border-strokedark">
                      <div className="flex flex-col gap-2">
                         {claim.status === 'pending' && (
                             <button 
                                onClick={() => handleShip(claim.id)}
                                disabled={!!updatingId}
                                className="bg-primary text-white text-xs py-1.5 px-3 rounded hover:bg-opacity-90 transition disabled:opacity-50"
                             >
                                Ship Product
                             </button>
                         )}
                         {claim.status === 'shipped' && (
                             <button 
                                onClick={() => updateStatus(claim.id, 'delivered')}
                                disabled={!!updatingId}
                                className="bg-success text-white text-xs py-1.5 px-3 rounded hover:bg-opacity-90 transition disabled:opacity-50"
                             >
                                Mark Delivered
                             </button>
                         )}
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

export default PrizeClaimsPage;
