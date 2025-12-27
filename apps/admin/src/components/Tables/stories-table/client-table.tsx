"use client";

import Image from "next/image";
import { useState } from "react";

export function StoriesTable({ initialStories }: { initialStories: any[] }) {
  const [stories, setStories] = useState(initialStories);
  const [loading, setLoading] = useState<string | null>(null);

  const handleDelete = async (id: string) => {
    if (!confirm("Are you sure you want to delete this story?")) return;
    setLoading(id);
    try {
      const res = await fetch(`/api/stories/${id}`, { method: "DELETE" });
      if (res.ok) {
        setStories(stories.filter((s) => s.id !== id));
        alert("Story deleted successfully");
      } else {
        alert("Failed to delete story");
      }
    } catch (err) {
      alert("Error deleting story");
    } finally {
      setLoading(null);
    }
  };

  return (
    <div className="rounded-[10px] bg-white px-7.5 pb-4 pt-7.5 shadow-1 dark:bg-gray-dark dark:shadow-card">
      <h4 className="mb-6 text-xl font-bold text-black dark:text-white">
        Recent Stories
      </h4>

      <div className="flex flex-col">
        <div className="grid grid-cols-3 sm:grid-cols-4">
          <div className="pb-3.5"><p className="text-sm font-medium uppercase">Story</p></div>
          <div className="pb-3.5 text-center"><p className="text-sm font-medium uppercase">User</p></div>
          <div className="hidden pb-3.5 text-center sm:block"><p className="text-sm font-medium uppercase">Created At</p></div>
          <div className="pb-3.5 text-center"><p className="text-sm font-medium uppercase">Actions</p></div>
        </div>

        {stories.map((story: any, key: number) => (
          <div className={`grid grid-cols-3 sm:grid-cols-4 ${key === stories.length - 1 ? "" : "border-b border-stroke dark:border-dark-3"}`} key={story.id}>
            <div className="flex items-center gap-3.5 py-5">
              <div className="h-12 w-12 overflow-hidden rounded-md border border-stroke">
                {story.imageUrl || story.mediaUrl ? (
                  <Image src={story.imageUrl || story.mediaUrl} alt="Story" width={48} height={48} className="object-cover h-full w-full" />
                ) : (
                  <div className="bg-gray-200 h-full w-full flex items-center justify-center text-[10px]">No Media</div>
                )}
              </div>
              <p className="hidden text-sm text-black dark:text-white sm:block truncate max-w-[100px]">
                {story.caption || "No caption"}
              </p>
            </div>
            <div className="flex items-center justify-center py-5">
              <p className="text-sm text-black dark:text-white">@{story.username || "Unknown"}</p>
            </div>
            <div className="hidden items-center justify-center py-5 sm:flex">
              <p className="text-sm text-black dark:text-white">
                {story.createdAt ? new Date(story.createdAt._seconds * 1000).toLocaleDateString() : "N/A"}
              </p>
            </div>
            <div className="flex items-center justify-center py-5">
              <button onClick={() => handleDelete(story.id)} disabled={loading === story.id} className="text-sm font-medium text-red-600 hover:underline">
                {loading === story.id ? '...' : 'Delete'}
              </button>
            </div>
          </div>
        ))}
        {stories.length === 0 && <p className="text-center py-10 text-gray-500">No stories found.</p>}
      </div>
    </div>
  );
}
