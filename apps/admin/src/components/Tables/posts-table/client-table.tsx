"use client";

import Image from "next/image";
import { useState } from "react";

export function PostsTable({ initialPosts }: { initialPosts: any[] }) {
  const [posts, setPosts] = useState(initialPosts);
  const [loading, setLoading] = useState<string | null>(null);

  const handleDelete = async (id: string) => {
    if (!confirm("Are you sure you want to delete this post?")) return;
    setLoading(id);
    try {
      const res = await fetch(`/api/posts/${id}`, { method: "DELETE" });
      if (res.ok) {
        setPosts(posts.filter((p) => p.id !== id));
        alert("Post deleted successfully");
      } else {
        alert("Failed to delete post");
      }
    } catch (err) {
      alert("Error deleting post");
    } finally {
      setLoading(null);
    }
  };

  return (
    <div className="rounded-[10px] bg-white px-7.5 pb-4 pt-7.5 shadow-1 dark:bg-gray-dark dark:shadow-card">
      <h4 className="mb-6 text-xl font-bold text-black dark:text-white">Recent Posts</h4>
      <div className="flex flex-col">
        <div className="grid grid-cols-3 sm:grid-cols-4 font-medium uppercase text-sm pb-3.5 border-b border-stroke dark:border-dark-3">
          <div>Post</div>
          <div className="text-center">User</div>
          <div className="hidden text-center sm:block">Date</div>
          <div className="text-center">Actions</div>
        </div>
        {posts.map((post: any, key: number) => (
          <div className="grid grid-cols-3 sm:grid-cols-4 border-b border-stroke dark:border-dark-3 py-4 items-center" key={post.id}>
            <div className="flex items-center gap-3">
              <div className="h-12 w-12 overflow-hidden rounded-md border">
                {(post.mediaUrl || post.imageUrl) && (
                  <Image src={post.mediaUrl || post.imageUrl} alt="Post" width={48} height={48} className="object-cover h-full w-full" />
                )}
              </div>
              <span className="truncate max-w-[100px] text-sm">{post.caption || "No caption"}</span>
            </div>
            <div className="text-center text-sm">@{post.username || "Unknown"}</div>
            <div className="hidden text-center text-sm sm:block">
              {post.createdAt ? new Date(post.createdAt._seconds * 1000).toLocaleDateString() : "N/A"}
            </div>
            <div className="text-center">
              <button onClick={() => handleDelete(post.id)} disabled={loading === post.id} className="text-red-600 text-sm hover:underline">
                {loading === post.id ? "..." : "Delete"}
              </button>
            </div>
          </div>
        ))}
        {posts.length === 0 && <p className="text-center py-10 text-gray-500">No posts found.</p>}
      </div>
    </div>
  );
}
