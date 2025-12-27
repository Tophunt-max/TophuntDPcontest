"use client";

import { BellIcon } from "./icons";
import {
  Dropdown,
  DropdownContent,
  DropdownTrigger,
} from "@/components/ui/dropdown";
import { cn } from "@/lib/utils";
import Link from "next/link";
import { useEffect, useState } from "react";
import { db } from "@/lib/firebase/config";
import { collection, query, orderBy, limit, onSnapshot, updateDoc, doc } from "firebase/firestore";

export function Notification() {
  const [isOpen, setIsOpen] = useState(false);
  const [notifications, setNotifications] = useState<any[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);

  useEffect(() => {
    const q = query(
      collection(db, "admin_notifications"), 
      orderBy("createdAt", "desc"), 
      limit(10)
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const docs = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      setNotifications(docs);
      setUnreadCount(docs.filter((n: any) => !n.isRead).length);
    }, (error) => {
      console.error("Notification listener error:", error);
    });

    return () => unsubscribe();
  }, []);

  const markAllAsRead = async () => {
    try {
      const unread = notifications.filter(n => !n.isRead);
      await Promise.all(unread.map(n => 
        updateDoc(doc(db, "admin_notifications", n.id), { isRead: true })
      ));
    } catch (e) {
      console.error("Error marking as read:", e);
    }
  };

  return (
    <Dropdown isOpen={isOpen} setIsOpen={setIsOpen}>
      <DropdownTrigger
        onClick={() => {
          if (!isOpen && unreadCount > 0) markAllAsRead();
        }}
        className="relative flex size-12 items-center justify-center rounded-full border border-stroke bg-gray-2 text-dark hover:text-primary dark:border-dark-3 dark:bg-dark-2 dark:text-white"
      >
        <BellIcon />

        {unreadCount > 0 && (
          <span className="absolute -right-0.5 -top-0.5 z-10 size-2.5 rounded-full border-2 border-white bg-red-dark dark:border-dark-2">
            <span className="absolute inset-0 inline-flex size-full animate-ping rounded-full bg-red-dark opacity-75"></span>
          </span>
        )}
      </DropdownTrigger>

      <DropdownContent
        className="mt-2 w-[300px] sm:w-[350px] p-0 border border-stroke bg-white shadow-default dark:border-dark-3 dark:bg-gray-dark"
        align="end"
      >
        <div className="px-4.5 py-3 border-b border-stroke dark:border-dark-3">
          <h5 className="text-sm font-medium text-body-color">Notifications</h5>
        </div>

        <ul className="flex h-auto max-h-[400px] flex-col overflow-y-auto">
          {notifications.length > 0 ? (
            notifications.map((notification) => (
              <li key={notification.id}>
                <Link
                  className="flex flex-col gap-1 border-b border-stroke px-4.5 py-3 hover:bg-gray-2 dark:border-dark-3 dark:hover:bg-dark-2"
                  href={notification.link || "#"}
                  onClick={() => setIsOpen(false)}
                >
                  <p className="text-sm text-black dark:text-white">
                    <span className="font-bold">{notification.title}</span> {notification.message}
                  </p>

                  <p className="text-xs text-gray-500">
                    {notification.createdAt?.toDate ? notification.createdAt.toDate().toLocaleTimeString() : "Just now"}
                  </p>
                </Link>
              </li>
            ))
          ) : (
            <li className="p-10 text-center text-sm text-gray-500">
              No new notifications
            </li>
          )}
        </ul>

        {notifications.length > 0 && (
            <div className="p-2 text-center border-t border-stroke dark:border-dark-3">
                <Link href="/reports" className="text-xs font-medium text-primary hover:underline">View All Activities</Link>
            </div>
        )}
      </DropdownContent>
    </Dropdown>
  );
}
