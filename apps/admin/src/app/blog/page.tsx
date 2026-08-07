"use client";

import React, { useEffect, useState } from "react";
import Breadcrumb from "@/components/Breadcrumbs/Breadcrumb";
import Link from "next/link";

interface BlogPost {
  id: string;
  slug: string;
  title: string;
  excerpt?: string;
  coverImageUrl?: string;
  category?: string;
  author?: string;
  status: string;
  source: string;
  viewCount?: number;
  publishedAt?: number;
  createdAt: number;
}

interface BlogStats {
  total: number;
  published: number;
  drafts: number;
  imported: number;
}

const BlogPage = () => {
  const [posts, setPosts] = useState<BlogPost[]>([]);
  const [stats, setStats] = useState<BlogStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  useEffect(() => {
    fetchStats();
  }, []);

  useEffect(() => {
    const t = setTimeout(() => fetchPosts(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  const fetchPosts = async (q = "") => {
    setLoading(true);
    try {
      const url = q.length >= 2 ? `/api/blog?q=${encodeURIComponent(q)}` : "/api/blog";
      const res = await fetch(url, { cache: "no-store" });
      const data = (await res.json()) as BlogPost[];
      setPosts(Array.isArray(data) ? data : []);
    } catch (error) {
      console.error("Error fetching posts:", error);
    } finally {
      setLoading(false);
    }
  };

  const fetchStats = async () => {
    try {
      const res = await fetch("/api/blog/stats", { cache: "no-store" });
      if (res.ok) setStats(await res.json());
    } catch {
      /* ignore */
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Are you sure you want to delete this post?")) return;
    try {
      const res = await fetch(`/api/blog/${id}`, { method: "DELETE" });
      if (res.ok) {
        setPosts((prev) => prev.filter((p) => p.id !== id));
        fetchStats();
      } else {
        const err = await res.json();
        alert(err.error || "Error deleting post");
      }
    } catch {
      alert("Error deleting post");
    }
  };

  const formatDate = (ts?: number) => {
    if (!ts) return "N/A";
    return new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  };

  const StatCard = ({ label, value, color }: { label: string; value: number; color: string }) => (
    <div className="rounded-sm border border-stroke bg-white py-4 px-5 shadow-default dark:border-strokedark dark:bg-boxdark">
      <span className="text-sm text-gray-500">{label}</span>
      <h4 className={`text-2xl font-bold ${color}`}>{value}</h4>
    </div>
  );

  return (
    <>
      <Breadcrumb pageName="Blog Management" />

      {stats && (
        <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4">
          <StatCard label="Total Posts" value={stats.total} color="text-black dark:text-white" />
          <StatCard label="Published" value={stats.published} color="text-success" />
          <StatCard label="Drafts" value={stats.drafts} color="text-warning" />
          <StatCard label="Imported (Archive)" value={stats.imported} color="text-primary" />
        </div>
      )}

      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <input
          type="text"
          placeholder="Search posts by title..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full rounded border-[1.5px] border-stroke bg-transparent px-5 py-3 text-black outline-none focus:border-primary dark:border-form-strokedark dark:bg-form-input dark:text-white sm:max-w-xs"
        />
        <Link
          href="/blog/create"
          className="inline-flex items-center justify-center gap-2.5 rounded-md bg-primary py-3 px-8 text-center font-medium text-white transition-all duration-300 hover:bg-opacity-90"
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5">
            <path fillRule="evenodd" d="M12 3.75a.75.75 0 0 1 .75.75v6.75h6.75a.75.75 0 0 1 0 1.5h-6.75v6.75a.75.75 0 0 1-1.5 0v-6.75H4.5a.75.75 0 0 1 0-1.5h6.75V4.5a.75.75 0 0 1 .75-.75Z" clipRule="evenodd" />
          </svg>
          New Post
        </Link>
      </div>

      <div className="rounded-sm border border-stroke bg-white px-5 pt-6 pb-2.5 shadow-default dark:border-strokedark dark:bg-boxdark sm:px-7.5 xl:pb-1">
        <div className="max-w-full overflow-x-auto">
          <table className="w-full table-auto">
            <thead>
              <tr className="bg-gray-2 text-left dark:bg-meta-4">
                <th className="min-w-[300px] py-4 px-4 font-medium text-black dark:text-white xl:pl-11">Post</th>
                <th className="min-w-[130px] py-4 px-4 font-medium text-black dark:text-white">Category</th>
                <th className="min-w-[110px] py-4 px-4 font-medium text-black dark:text-white">Status</th>
                <th className="min-w-[90px] py-4 px-4 font-medium text-black dark:text-white">Views</th>
                <th className="min-w-[120px] py-4 px-4 font-medium text-black dark:text-white">Date</th>
                <th className="py-4 px-4 font-medium text-black dark:text-white">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={6} className="py-10 text-center">
                    <div className="flex items-center justify-center space-x-2">
                      <div className="h-4 w-4 animate-bounce rounded-full bg-primary [animation-delay:-0.3s]"></div>
                      <div className="h-4 w-4 animate-bounce rounded-full bg-primary [animation-delay:-0.15s]"></div>
                      <div className="h-4 w-4 animate-bounce rounded-full bg-primary"></div>
                    </div>
                  </td>
                </tr>
              ) : posts.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-10 text-center text-gray-500">
                    No posts found. Create one or run the archive importer.
                  </td>
                </tr>
              ) : (
                posts.map((post) => (
                  <tr key={post.id} className="transition-colors hover:bg-gray-50 dark:hover:bg-meta-4">
                    <td className="border-b border-[#eee] py-5 px-4 pl-9 dark:border-strokedark xl:pl-11">
                      <div className="flex items-center gap-4">
                        {post.coverImageUrl ? (
                          <div className="h-12 w-16 flex-shrink-0 overflow-hidden rounded-md border border-stroke">
                            <img src={post.coverImageUrl} alt="" className="h-full w-full object-cover" />
                          </div>
                        ) : (
                          <div className="flex h-12 w-16 flex-shrink-0 items-center justify-center rounded-md bg-gray-2 text-xl">
                            📝
                          </div>
                        )}
                        <div>
                          <h5 className="font-semibold text-black dark:text-white">{post.title}</h5>
                          <span className="block text-xs text-gray-500">/{post.slug}</span>
                          {post.source === "archive" && (
                            <span className="mt-1 inline-block rounded bg-primary bg-opacity-10 px-2 py-0.5 text-[10px] font-medium text-primary">
                              Archived
                            </span>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="border-b border-[#eee] py-5 px-4 dark:border-strokedark">
                      <span className="text-sm text-black dark:text-white">{post.category || "—"}</span>
                    </td>
                    <td className="border-b border-[#eee] py-5 px-4 dark:border-strokedark">
                      <span
                        className={`inline-flex rounded-full bg-opacity-10 py-1 px-3 text-sm font-medium ${
                          post.status === "published" ? "bg-success text-success" : "bg-warning text-warning"
                        }`}
                      >
                        {post.status === "published" ? "Published" : "Draft"}
                      </span>
                    </td>
                    <td className="border-b border-[#eee] py-5 px-4 dark:border-strokedark">
                      <span className="text-sm text-black dark:text-white">{post.viewCount ?? 0}</span>
                    </td>
                    <td className="border-b border-[#eee] py-5 px-4 dark:border-strokedark">
                      <span className="text-sm text-gray-500">{formatDate(post.publishedAt || post.createdAt)}</span>
                    </td>
                    <td className="border-b border-[#eee] py-5 px-4 dark:border-strokedark">
                      <div className="flex items-center space-x-3.5">
                        <Link href={`/blog/${post.id}/edit`} className="transition-colors hover:text-primary" title="Edit">
                          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="h-5 w-5">
                            <path strokeLinecap="round" strokeLinejoin="round" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Zm0 0L19.5 7.125" />
                          </svg>
                        </Link>
                        <button onClick={() => handleDelete(post.id)} className="transition-colors hover:text-danger" title="Delete">
                          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="h-5 w-5">
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

export default BlogPage;
