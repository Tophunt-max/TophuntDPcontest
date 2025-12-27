"use client";

import Breadcrumb from "@/components/Breadcrumbs/Breadcrumb";
import { useState, useEffect } from "react";
import { Modal } from "@/components/ui/modal";

export default function SupportPage() {
  const [tickets, setTickets] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedTicket, setSelectedTicket] = useState<any>(null);
  const [reply, setReply] = useState("");

  useEffect(() => {
    fetch("/api/support")
      .then(res => res.json())
      .then(data => {
        setTickets(data);
        setLoading(false);
      });
  }, []);

  const handleUpdate = async () => {
    try {
      const res = await fetch("/api/support", {
        method: "PATCH",
        body: JSON.stringify({ 
            id: selectedTicket.id, 
            status: "resolved",
            adminReply: reply
        }),
        headers: { "Content-Type": "application/json" }
      });
      if (res.ok) {
        setTickets(tickets.map(t => t.id === selectedTicket.id ? { ...t, status: "resolved", adminReply: reply } : t));
        setSelectedTicket(null);
        setReply("");
      }
    } catch (err) { alert("Error updating"); }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this ticket?")) return;
    try {
      const res = await fetch(`/api/support?id=${id}`, { method: "DELETE" });
      if (res.ok) setTickets(tickets.filter(t => t.id !== id));
    } catch (err) { alert("Error deleting"); }
  };

  if (loading) return <div className="p-10 text-center text-black dark:text-white">Loading Tickets...</div>;

  return (
    <div className="mx-auto max-w-6xl text-black dark:text-white">
      <Breadcrumb pageName="Support Tickets" />
      <div className="rounded-[10px] bg-white p-6 shadow-1 dark:bg-gray-dark border border-stroke dark:border-dark-3">
        <div className="overflow-x-auto">
          <table className="w-full table-auto">
            <thead>
              <tr className="bg-gray-2 text-left dark:bg-dark-2">
                <th className="px-4 py-4 font-medium">User</th>
                <th className="px-4 py-4 font-medium">Subject</th>
                <th className="px-4 py-4 font-medium">Status</th>
                <th className="px-4 py-4 font-medium">Date</th>
                <th className="px-4 py-4 font-medium text-center">Actions</th>
              </tr>
            </thead>
            <tbody>
              {tickets.map((ticket) => (
                <tr key={ticket.id} className="border-b border-stroke dark:border-dark-3 hover:bg-gray-50 dark:hover:bg-dark-2">
                  <td className="px-4 py-5 text-sm">@{ticket.username || "unknown"}</td>
                  <td className="px-4 py-5 text-sm font-medium">{ticket.subject || "No Subject"}</td>
                  <td className="px-4 py-5">
                    <span className={`px-2 py-1 rounded-full text-[10px] font-bold ${ticket.status === 'resolved' ? 'bg-green-100 text-green-600' : 'bg-yellow-100 text-yellow-600'}`}>
                      {ticket.status?.toUpperCase() || "PENDING"}
                    </span>
                  </td>
                  <td className="px-4 py-5 text-sm">{ticket.createdAt ? ticket.createdAt.split('T')[0] : 'N/A'}</td>
                  <td className="px-4 py-5 text-center flex justify-center gap-2">
                    <button onClick={() => setSelectedTicket(ticket)} className="text-primary hover:underline text-xs font-medium">View/Reply</button>
                    <button onClick={() => handleDelete(ticket.id)} className="text-red-500 hover:underline text-xs font-medium">Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {tickets.length === 0 && <p className="text-center py-10 text-gray-500">No support tickets found.</p>}
        </div>
      </div>

      {/* Ticket Detail & Reply Modal */}
      {selectedTicket && (
        <Modal
            isOpen={!!selectedTicket}
            onClose={() => setSelectedTicket(null)}
            title="Ticket Details"
            onConfirm={handleUpdate}
            confirmLabel="Mark as Resolved"
        >
            <div className="space-y-4">
                <div>
                    <p className="text-[10px] font-bold text-gray-400 uppercase">Message from User</p>
                    <p className="text-sm bg-gray-100 dark:bg-dark-2 p-3 rounded-lg mt-1">{selectedTicket.message}</p>
                </div>
                <div>
                    <label className="text-[10px] font-bold text-gray-400 uppercase">Admin Reply</label>
                    <textarea 
                        value={reply}
                        onChange={(e) => setReply(e.target.value)}
                        placeholder="Type your reply here..."
                        className="w-full mt-1 p-3 text-sm rounded-lg border border-stroke dark:border-dark-3 bg-transparent outline-none focus:border-primary"
                        rows={3}
                    />
                </div>
            </div>
        </Modal>
      )}
    </div>
  );
}
