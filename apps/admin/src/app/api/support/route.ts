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
    const snapshot = await db.collection("support_tickets").orderBy("createdAt", "desc").limit(100).get();
    const tickets = snapshot.docs.map(doc => ({ id: doc.id, ...serializeData(doc.data()) }));
    return NextResponse.json(tickets);
  } catch (error) {
    return NextResponse.json([]);
  }
}

export async function PATCH(request: Request) {
    try {
      const body = await request.json();
      const { id, status, adminReply } = body;
      
      if (!id) return NextResponse.json({ error: "ID required" }, { status: 400 });

      await db.collection("support_tickets").doc(id).update({
        status: status || "resolved",
        adminReply: adminReply || "",
        updatedAt: new Date()
      });

      return NextResponse.json({ message: "Ticket updated" });
    } catch (error) {
      return NextResponse.json({ error: "Failed" }, { status: 500 });
    }
}

export async function DELETE(request: Request) {
    try {
      const { searchParams } = new URL(request.url);
      const id = searchParams.get("id");
      if (id) await db.collection("support_tickets").doc(id).delete();
      return NextResponse.json({ message: "Ticket deleted" });
    } catch (error) {
      return NextResponse.json({ error: "Failed" }, { status: 500 });
    }
}
