"use client";

import Image from "next/image";
import { useState } from "react";

export function UserContentTabs({ initialPosts, initialStories }: { initialPosts: any[], initialStories: any[] }) {
  const [posts, setPosts] = useState(initialPosts);
  const [stories, setStories] = useState(initialStories);
  const [loading, setLoading] = useState<string | null>(null);

  const handleDelete = async (type: 'posts' | 'stories', id: string) => {
    if (!confirm(`Are you sure you want to delete this ${type.slice(0, -1)}?`)) return;
    setLoading(id);
    try {
      const res = await fetch(`/api/${type}/${id}`, { method: "DELETE" });
      if (res.ok) {
        if (type === 'posts') setPosts(posts.filter(p => p.id !== id));
        else setStories(stories.filter(s => s.id !== id));
      }
    } catch (err) {
      alert("Error deleting item");
    } finally {
      setLoading(null);
    }
  };

  const toggleHide = async (type: 'posts' | 'stories', id: string, currentHidden: boolean) => {
    setLoading(id);
    try {
      const res = await fetch(`/api/${type}/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ isHidden: !currentHidden }),
        headers: { "Content-Type": "application/json" },
      });
      if (res.ok) {
        if (type === 'posts') setPosts(posts.map(p => p.id === id ? { ...p, isHidden: !currentHidden } : p));
        else setStories(stories.map(s => s.id === id ? { ...s, isHidden: !currentHidden } : s));
      }
    } catch (err) {
      alert("Error updating status");
    } finally {
      setLoading(null);
    }
  };

  return (
    <div className="space-y-6">
      {/* Stories Section */}
      <div className="rounded-[10px] bg-white p-6 shadow-1 dark:bg-gray-dark">
        <h4 className="mb-4 text-lg font-bold text-black dark:text-white">Stories ({stories.length})</h4>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
          {stories.map((story: any) => (
            <div key={story.id} className="group relative flex flex-col space-y-2">
              <div className={`relative aspect-[9/16] overflow-hidden rounded-lg border dark:border-dark-3 bg-gray-100 ${story.isHidden ? 'opacity-50 grayscale' : ''}`}>
                {(story.imageUrl || story.mediaUrl) ? (
                  <Image src={story.imageUrl || story.mediaUrl} alt="Story" fill className="object-cover" />
                ) : <div className="flex items-center justify-center h-full text-[10px]">No Media</div>}
                
                {story.isHidden && (
                  <div className="absolute inset-0 flex items-center justify-center bg-black/40 text-white text-[10px] font-bold">HIDDEN</div>
                )}
              </div>
              <div className="flex justify-between gap-1">
                <button 
                  onClick={() => toggleHide('stories', story.id, !!story.isHidden)}
                  disabled={loading === story.id}
                  className="flex-1 text-[10px] font-bold py-1 rounded bg-gray-100 dark:bg-dark-2 hover:bg-gray-200"
                >
                  {story.isHidden ? 'SHOW' : 'HIDE'}
                </button>
                <button 
                  onClick={() => handleDelete('stories', story.id)}
                  disabled={loading === story.id}
                  className="flex-1 text-[10px] font-bold py-1 rounded bg-red-50 text-red-600 hover:bg-red-100"
                >
                  DEL
                </button>
              </div>
            </div>
          ))}
          {stories.length === 0 && <p className="text-sm text-gray-500 col-span-full font-medium">No stories found.</p>}
        </div>
      </div>

      {/* Posts Section */}
      <div className="rounded-[10px] bg-white p-6 shadow-1 dark:bg-gray-dark">
        <h4 className="mb-4 text-lg font-bold text-black dark:text-white">Posts ({posts.length})</h4>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          {posts.map((post: any) => (
            <div key={post.id} className="group flex flex-col space-y-2">
              <div className={`relative aspect-square overflow-hidden rounded-lg border dark:border-dark-3 bg-gray-100 ${post.isHidden ? 'opacity-50 grayscale' : ''}`}>
                {(post.mediaUrl || post.imageUrl) ? (
                  <Image src={post.mediaUrl || post.imageUrl} alt="Post" fill className="object-cover" />
                ) : <div className="flex items-center justify-center h-full text-xs">No Media</div>}

                {post.isHidden && (
                  <div className="absolute inset-0 flex items-center justify-center bg-black/40 text-white text-xs font-bold">HIDDEN</div>
                )}
              </div>
              <p className="text-[10px] truncate text-gray-500 px-1">{post.caption || "No caption"}</p>
              <div className="flex justify-between gap-1">
                <button 
                  onClick={() => toggleHide('posts', post.id, !!post.isHidden)}
                  disabled={loading === post.id}
                  className="flex-1 text-[10px] font-bold py-1 rounded bg-gray-100 dark:bg-dark-2 hover:bg-gray-200"
                >
                  {post.isHidden ? 'SHOW' : 'HIDE'}
                </button>
                <button 
                  onClick={() => handleDelete('posts', post.id)}
                  disabled={loading === post.id}
                  className="flex-1 text-[10px] font-bold py-1 rounded bg-red-50 text-red-600 hover:bg-red-100"
                >
                  DEL
                </button>
              </div>
            </div>
          ))}
          {posts.length === 0 && <p className="text-sm text-gray-500 col-span-full font-medium">No posts found.</p>}
        </div>
      </div>
    </div>
  );
}
