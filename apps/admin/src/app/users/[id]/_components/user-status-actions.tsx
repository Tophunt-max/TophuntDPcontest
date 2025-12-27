"use client";

import { useState } from "react";
import { Modal } from "@/components/ui/modal";

export function UserStatusActions({ userId, initialIsBlocked }: { userId: string, initialIsBlocked: boolean }) {
  const [isBlocked, setIsBlocked] = useState(initialIsBlocked);
  const [loading, setLoading] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);

  const toggleBlock = async () => {
    setIsModalOpen(false);
    setLoading(true);
    try {
      const res = await fetch(`/api/users/${userId}`, {
        method: "PATCH",
        body: JSON.stringify({ isBlocked: !isBlocked }),
        headers: { "Content-Type": "application/json" },
      });
      
      const data = await res.json();
      
      if (res.ok) {
        // Explicitly set the new state from response if possible, or just toggle
        setIsBlocked(!isBlocked);
        alert(data.message);
      } else {
        alert(data.error || "Failed to update status");
      }
    } catch (err) {
      console.error("Fetch error:", err);
      alert("Error updating status");
    } finally {
      setLoading(false);
    }
  };

  const action = isBlocked ? "unban" : "ban";

  return (
    <div className="mt-6 flex flex-col gap-2 border-t border-stroke pt-6 dark:border-dark-3">
      <p className="text-xs font-semibold uppercase text-gray-400">Moderation Tools</p>
      
      {/* Visual Status Indicator */}
      <div className="mb-2 text-sm">
        Current Status: <span className={isBlocked ? "text-red-600 font-bold" : "text-green-600 font-bold"}>
            {isBlocked ? "BANNED" : "ACTIVE"}
        </span>
      </div>

      <button
        onClick={() => setIsModalOpen(true)}
        disabled={loading}
        className={`w-full rounded-lg py-2.5 text-sm font-medium text-white transition-colors ${
          isBlocked 
            ? "bg-green-600 hover:bg-green-700" 
            : "bg-red-600 hover:bg-red-700"
        }`}
      >
        {loading ? "Processing..." : (isBlocked ? "UNBAN USER" : "BAN USER")}
      </button>

      <Modal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        title={`${isBlocked ? 'Unban' : 'Ban'} User`}
        onConfirm={toggleBlock}
        confirmLabel={isBlocked ? "Unban Now" : "Ban Now"}
        type={isBlocked ? "info" : "danger"}
      >
        Are you sure you want to <strong>{action}</strong> this user? 
        {isBlocked ? " They will regain access to the application." : " They will be restricted from using the application."}
      </Modal>
    </div>
  );
}
