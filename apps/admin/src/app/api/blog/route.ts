import { NextResponse } from "next/server";
import { workerAdmin, forward } from "@/lib/worker";

// List all blog posts (admin) from the Worker / D1.
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const q = searchParams.get("q");
    const path = q ? `/blog?q=${encodeURIComponent(q)}` : "/blog";
    const { data, status } = await forward(await workerAdmin(path));
    return NextResponse.json(data, { status });
  } catch (error) {
    return NextResponse.json([], { status: 200 });
  }
}

// Create a new blog post.
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { data, status } = await forward(await workerAdmin("/blog", { method: "POST", body }));
    return NextResponse.json(data, { status });
  } catch (error: any) {
    console.error("Error creating blog post:", error);
    return NextResponse.json({ error: error.message || "Failed to create post" }, { status: 500 });
  }
}
