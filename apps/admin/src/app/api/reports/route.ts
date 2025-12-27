import { db } from "@/lib/firebase/admin";
import { NextResponse } from "next/server";

function serializeData(data: any) {
    const serialized = { ...data };
    for (const key in serialized) {
      if (serialized[key] && typeof serialized[key].toDate === "function") {
        serialized[key] = serialized[key].toDate().toISOString();
      }
    }
    return serialized;
}

export async function GET() {
  try {
    const snapshot = await db.collection("reports").orderBy("createdAt", "desc").limit(100).get();
    const reports = snapshot.docs.map(doc => ({ id: doc.id, ...serializeData(doc.data()) }));
    return NextResponse.json(reports);
  } catch (error) {
    // If collection doesn't exist, return empty
    return NextResponse.json([]);
  }
}

export async function DELETE(request: Request) {
    try {
      const { searchParams } = new URL(request.url);
      const id = searchParams.get("id");
      if (id) await db.collection("reports").doc(id).delete();
      return NextResponse.json({ message: "Report deleted" });
    } catch (error) {
      return NextResponse.json({ error: "Failed" }, { status: 500 });
    }
}
