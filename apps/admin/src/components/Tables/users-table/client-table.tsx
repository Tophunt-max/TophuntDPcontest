"use client";

import { useState, useMemo } from "react";
import Link from "next/link";

export function UsersTable({ initialUsers }: { initialUsers: any[] }) {
  const [users, setUsers] = useState(initialUsers);
  const [loading, setLoading] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation();
    if (!confirm("Are you sure you want to delete this user?")) return;
    setLoading(id);
    try {
      const res = await fetch(`/api/users/${id}`, { method: "DELETE" });
      if (res.ok) setUsers(users.filter((u) => u.id !== id));
    } catch (err) { alert("Error deleting user"); }
    finally { setLoading(null); }
  };

  const filteredUsers = useMemo(() => {
    return users.filter((user) => {
      const searchStr = searchQuery.toLowerCase();
      return (
        user.fullName?.toLowerCase().includes(searchStr) ||
        user.email?.toLowerCase().includes(searchStr) ||
        user.username?.toLowerCase().includes(searchStr) ||
        user.phone?.includes(searchStr)
      );
    });
  }, [users, searchQuery]);

  return (
    <div className="rounded-[10px] bg-white px-7.5 pb-4 pt-7.5 shadow-1 dark:bg-gray-dark dark:shadow-card">
      <div className="flex flex-col gap-4 mb-6 sm:flex-row sm:items-center sm:justify-between">
        <h4 className="text-xl font-bold text-black dark:text-white">
          All Registered Users ({filteredUsers.length})
        </h4>
        <input
            type="text"
            placeholder="Search users..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full max-w-xs rounded-lg border border-stroke bg-transparent py-2 px-4 text-sm outline-none focus:border-primary dark:border-dark-3 dark:bg-dark-2 text-black dark:text-white"
        />
      </div>

      <div className="flex flex-col">
        <div className="grid grid-cols-4 sm:grid-cols-5 font-medium uppercase text-sm pb-3.5 border-b border-stroke dark:border-dark-3">
          <div className="text-black dark:text-white">User</div>
          <div className="text-center text-black dark:text-white">Email</div>
          <div className="text-center text-black dark:text-white">Username</div>
          <div className="hidden text-center sm:block text-black dark:text-white">Status</div>
          <div className="text-center text-black dark:text-white">Actions</div>
        </div>
        
        {filteredUsers.map((user: any) => {
            const avatarSrc = user.profileImageUrl || user.profilePicture || user.avatarUrl;
            return (
              <Link 
                href={`/users/${user.id}`}
                className="grid grid-cols-4 sm:grid-cols-5 border-b border-stroke dark:border-dark-3 py-4 items-center hover:bg-gray-50 dark:hover:bg-dark-2 transition-colors cursor-pointer" 
                key={user.id}
              >
                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 overflow-hidden rounded-full flex-shrink-0 bg-gray-100 border border-stroke dark:border-dark-3 flex items-center justify-center">
                    {avatarSrc ? (
                        <img 
                            src={avatarSrc} 
                            alt="Avatar" 
                            className="h-full w-full object-cover"
                            onError={(e) => {
                                (e.target as HTMLImageElement).onerror = null;
                                (e.target as HTMLImageElement).style.display = 'none';
                                (e.target as HTMLImageElement).parentElement!.innerHTML = `<span class="text-xs font-bold text-gray-500">${(user.fullName || "U").charAt(0)}</span>`;
                            }}
                        />
                    ) : (
                        <span className="text-xs font-bold text-gray-500">{(user.fullName || user.username || "U").charAt(0).toUpperCase()}</span>
                    )}
                  </div>
                  <div className="hidden sm:block text-black dark:text-white overflow-hidden">
                      <p className="text-sm font-medium truncate max-w-[120px]">
                          {user.fullName || "Anonymous"}
                      </p>
                      <p className="text-[10px] text-gray-400">{user.phone || ""}</p>
                  </div>
                </div>
                <div className="text-center text-sm truncate px-2 text-black dark:text-white">{user.email || "N/A"}</div>
                <div className="text-center text-sm text-black dark:text-white">@{user.username || "N/A"}</div>
                <div className="hidden text-center sm:block text-xs">
                  <span className={`px-2 py-1 rounded-full ${user.isBlocked ? 'bg-red-100 text-red-600' : 'bg-green-100 text-green-600'}`}>
                    {user.isBlocked ? 'Blocked' : 'Active'}
                  </span>
                </div>
                <div className="text-center flex gap-2 justify-center">
                  <button onClick={(e) => handleDelete(user.id, e)} className="text-red-500 hover:underline text-xs">
                    {loading === user.id ? "..." : "Delete"}
                  </button>
                </div>
              </Link>
            )
        })}
      </div>
    </div>
  );
}
