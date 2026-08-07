"use client";

import React, { useEffect, useState } from "react";
import DefaultLayout from "@/components/Layouts/DefaultLayout";
import Breadcrumb from "@/components/Breadcrumbs/Breadcrumb";
import { useRouter, useParams } from "next/navigation";
import { uploadPhotoToS3 } from "@/lib/s3-upload";

const EditBlogPost = () => {
  const router = useRouter();
  const params = useParams();
  const id = params?.id as string;

  const [loading, setLoading] = useState(false);
  const [fetching, setFetching] = useState(true);
  const [uploading, setUploading] = useState(false);

  const [formData, setFormData] = useState({
    title: "",
    slug: "",
    category: "",
    author: "TopHunt",
    status: "published",
    excerpt: "",
    coverImageUrl: "",
    tags: "",
    content: "",
  });

  const set = (key: string, value: string) => setFormData((prev) => ({ ...prev, [key]: value }));

  useEffect(() => {
    if (!id) return;
    (async () => {
      try {
        const res = await fetch(`/api/blog/${id}`, { cache: "no-store" });
        const data = await res.json();
        if (data) {
          setFormData({
            title: data.title || "",
            slug: data.slug || "",
            category: data.category || "",
            author: data.author || "TopHunt",
            status: data.status || "published",
            excerpt: data.excerpt || "",
            coverImageUrl: data.coverImageUrl || "",
            tags: Array.isArray(data.tags) ? data.tags.join(", ") : "",
            content: data.content || "",
          });
        }
      } catch (err) {
        console.error(err);
      } finally {
        setFetching(false);
      }
    })();
  }, [id]);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const url = await uploadPhotoToS3(file, "blog/covers");
      set("coverImageUrl", url);
    } catch (err: any) {
      alert("Image upload failed: " + err.message);
    } finally {
      setUploading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const payload = {
        ...formData,
        tags: formData.tags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
      };
      const res = await fetch(`/api/blog/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to update post");
      }
      router.push("/blog");
    } catch (error: any) {
      alert("Error: " + error.message);
    } finally {
      setLoading(false);
    }
  };

  if (fetching) {
    return (
      <DefaultLayout>
        <div className="flex h-60 items-center justify-center">
          <div className="flex items-center justify-center space-x-2">
            <div className="h-4 w-4 animate-bounce rounded-full bg-primary [animation-delay:-0.3s]"></div>
            <div className="h-4 w-4 animate-bounce rounded-full bg-primary [animation-delay:-0.15s]"></div>
            <div className="h-4 w-4 animate-bounce rounded-full bg-primary"></div>
          </div>
        </div>
      </DefaultLayout>
    );
  }

  return (
    <DefaultLayout>
      <Breadcrumb pageName="Edit Blog Post" />

      <form onSubmit={handleSubmit} className="grid grid-cols-1 gap-9 lg:grid-cols-3">
        <div className="flex flex-col gap-9 lg:col-span-2">
          <div className="rounded-sm border border-stroke bg-white shadow-default dark:border-strokedark dark:bg-boxdark">
            <div className="border-b border-stroke px-6.5 py-4 dark:border-strokedark">
              <h3 className="text-lg font-medium text-black dark:text-white">📝 Content</h3>
            </div>
            <div className="p-6.5">
              <div className="mb-4.5">
                <label className="mb-2.5 block font-medium text-black dark:text-white">
                  Title <span className="text-meta-1">*</span>
                </label>
                <input
                  type="text"
                  className="w-full rounded border-[1.5px] border-stroke bg-transparent px-5 py-3 text-black outline-none focus:border-primary dark:border-form-strokedark dark:bg-form-input dark:text-white"
                  value={formData.title}
                  onChange={(e) => set("title", e.target.value)}
                  required
                />
              </div>

              <div className="mb-4.5">
                <label className="mb-2.5 block font-medium text-black dark:text-white">Excerpt</label>
                <textarea
                  rows={2}
                  className="w-full rounded border-[1.5px] border-stroke bg-transparent px-5 py-3 text-black outline-none focus:border-primary dark:border-form-strokedark dark:bg-form-input dark:text-white"
                  value={formData.excerpt}
                  onChange={(e) => set("excerpt", e.target.value)}
                />
              </div>

              <div className="mb-1">
                <label className="mb-2.5 block font-medium text-black dark:text-white">Content (HTML supported)</label>
                <textarea
                  rows={16}
                  className="w-full rounded border-[1.5px] border-stroke bg-transparent px-5 py-3 font-mono text-sm text-black outline-none focus:border-primary dark:border-form-strokedark dark:bg-form-input dark:text-white"
                  value={formData.content}
                  onChange={(e) => set("content", e.target.value)}
                />
              </div>
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-9">
          <div className="rounded-sm border border-stroke bg-white shadow-default dark:border-strokedark dark:bg-boxdark">
            <div className="border-b border-stroke px-6.5 py-4 dark:border-strokedark">
              <h3 className="text-lg font-medium text-black dark:text-white">⚙️ Settings</h3>
            </div>
            <div className="p-6.5">
              <div className="mb-4.5">
                <label className="mb-2.5 block font-medium text-black dark:text-white">Cover Image</label>
                <input
                  type="file"
                  accept="image/*"
                  onChange={handleFileChange}
                  className="w-full cursor-pointer rounded-lg border-[1.5px] border-stroke bg-transparent font-medium"
                />
                {uploading && <p className="mt-2 text-xs text-primary">Uploading…</p>}
                {formData.coverImageUrl && (
                  <img src={formData.coverImageUrl} className="mt-4 h-32 w-full rounded-md border object-cover" />
                )}
              </div>

              <div className="mb-4.5">
                <label className="mb-2.5 block font-medium text-black dark:text-white">Status</label>
                <select
                  className="w-full rounded border border-stroke bg-transparent px-5 py-3 dark:border-form-strokedark dark:bg-form-input"
                  value={formData.status}
                  onChange={(e) => set("status", e.target.value)}
                >
                  <option value="published">Published</option>
                  <option value="draft">Draft</option>
                </select>
              </div>

              <div className="mb-4.5">
                <label className="mb-2.5 block font-medium text-black dark:text-white">Category</label>
                <input
                  type="text"
                  className="w-full rounded border-[1.5px] border-stroke bg-transparent px-5 py-3 text-black outline-none focus:border-primary dark:border-form-strokedark dark:bg-form-input dark:text-white"
                  value={formData.category}
                  onChange={(e) => set("category", e.target.value)}
                />
              </div>

              <div className="mb-4.5">
                <label className="mb-2.5 block font-medium text-black dark:text-white">Tags (comma separated)</label>
                <input
                  type="text"
                  className="w-full rounded border-[1.5px] border-stroke bg-transparent px-5 py-3 text-black outline-none focus:border-primary dark:border-form-strokedark dark:bg-form-input dark:text-white"
                  value={formData.tags}
                  onChange={(e) => set("tags", e.target.value)}
                />
              </div>

              <div className="mb-4.5">
                <label className="mb-2.5 block font-medium text-black dark:text-white">Author</label>
                <input
                  type="text"
                  className="w-full rounded border-[1.5px] border-stroke bg-transparent px-5 py-3 text-black outline-none focus:border-primary dark:border-form-strokedark dark:bg-form-input dark:text-white"
                  value={formData.author}
                  onChange={(e) => set("author", e.target.value)}
                />
              </div>

              <div className="mb-1">
                <label className="mb-2.5 block font-medium text-black dark:text-white">Slug</label>
                <input
                  type="text"
                  className="w-full rounded border-[1.5px] border-stroke bg-transparent px-5 py-3 text-black outline-none focus:border-primary dark:border-form-strokedark dark:bg-form-input dark:text-white"
                  value={formData.slug}
                  onChange={(e) => set("slug", e.target.value)}
                />
              </div>
            </div>
          </div>

          <button
            type="submit"
            disabled={loading || uploading}
            className="w-full rounded bg-primary p-3 font-medium text-white hover:bg-opacity-90 disabled:opacity-50"
          >
            {loading ? "Saving…" : "💾 Save Changes"}
          </button>
        </div>
      </form>
    </DefaultLayout>
  );
};

export default EditBlogPost;
