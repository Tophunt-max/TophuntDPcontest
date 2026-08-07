"use client";

import React, { useState } from "react";
import DefaultLayout from "@/components/Layouts/DefaultLayout";
import Breadcrumb from "@/components/Breadcrumbs/Breadcrumb";
import { useRouter } from "next/navigation";
import { uploadPhotoToS3 } from "@/lib/s3-upload";

const CreateBlogPost = () => {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [coverPreview, setCoverPreview] = useState<string | null>(null);

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

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setCoverPreview(URL.createObjectURL(file));
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
    if (!formData.title.trim()) {
      alert("Title is required.");
      return;
    }
    setLoading(true);
    try {
      const payload = {
        ...formData,
        tags: formData.tags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
      };
      const res = await fetch("/api/blog", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to create post");
      }
      router.push("/blog");
    } catch (error: any) {
      alert("Error: " + error.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <DefaultLayout>
      <Breadcrumb pageName="Create Blog Post" />

      <form onSubmit={handleSubmit} className="grid grid-cols-1 gap-9 lg:grid-cols-3">
        {/* Main content */}
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
                  placeholder="Post title"
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
                  placeholder="Short summary shown on list cards"
                  className="w-full rounded border-[1.5px] border-stroke bg-transparent px-5 py-3 text-black outline-none focus:border-primary dark:border-form-strokedark dark:bg-form-input dark:text-white"
                  value={formData.excerpt}
                  onChange={(e) => set("excerpt", e.target.value)}
                />
              </div>

              <div className="mb-1">
                <label className="mb-2.5 block font-medium text-black dark:text-white">Content (HTML supported)</label>
                <textarea
                  rows={16}
                  placeholder="<p>Write your post here. HTML tags like <h2>, <p>, <img>, <ul> are supported.</p>"
                  className="w-full rounded border-[1.5px] border-stroke bg-transparent px-5 py-3 font-mono text-sm text-black outline-none focus:border-primary dark:border-form-strokedark dark:bg-form-input dark:text-white"
                  value={formData.content}
                  onChange={(e) => set("content", e.target.value)}
                />
              </div>
            </div>
          </div>
        </div>

        {/* Sidebar */}
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
                {coverPreview && <img src={coverPreview} className="mt-4 h-32 w-full rounded-md border object-cover" />}
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
                  placeholder="e.g. Quiz Answers"
                  className="w-full rounded border-[1.5px] border-stroke bg-transparent px-5 py-3 text-black outline-none focus:border-primary dark:border-form-strokedark dark:bg-form-input dark:text-white"
                  value={formData.category}
                  onChange={(e) => set("category", e.target.value)}
                />
              </div>

              <div className="mb-4.5">
                <label className="mb-2.5 block font-medium text-black dark:text-white">Tags (comma separated)</label>
                <input
                  type="text"
                  placeholder="gk, amazon quiz"
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
                <label className="mb-2.5 block font-medium text-black dark:text-white">Custom Slug (optional)</label>
                <input
                  type="text"
                  placeholder="auto-generated from title"
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
            {loading ? "Publishing…" : "🚀 Publish Post"}
          </button>
        </div>
      </form>
    </DefaultLayout>
  );
};

export default CreateBlogPost;
