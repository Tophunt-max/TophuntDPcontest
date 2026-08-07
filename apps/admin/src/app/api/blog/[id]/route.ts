import { NextResponse } from "next/server";
import { workerAdmin, forward } from "@/lib/worker";

// Fetch a single post (with content) for the edit form.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { data, status } = await forward(await workerAdmin(`/blog/${id}`));
    return NextResponse.json(data, { status });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || "Failed to fetch post" }, { status: 500 });
  }
}

// Update a post.
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await request.json();
    const { data, status } = await forward(await workerAdmin(`/blog/${id}`, { method: "PATCH", body }));
    return NextResponse.json(data, { status });
  } catch (error: any) {
    console.error("Error updating blog post:", error);
    return NextResponse.json({ error: error.message || "Failed to update post" }, { status: 500 });
  }
}

// Delete a post.
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { data, status } = await forward(await workerAdmin(`/blog/${id}`, { method: "DELETE" }));
    return NextResponse.json(data, { status });
  } catch (error: any) {
    console.error("Error deleting blog post:", error);
    return NextResponse.json({ error: error.message || "Failed to delete post" }, { status: 500 });
  }
}
