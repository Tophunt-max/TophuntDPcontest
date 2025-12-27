"use client";

import { ChevronUpIcon } from "@/assets/icons";
import {
  Dropdown,
  DropdownContent,
  DropdownTrigger,
} from "@/components/ui/dropdown";
import { cn } from "@/lib/utils";
import Link from "next/link";
import { useState } from "react";
import { LogOutIcon, SettingsIcon, UserIcon } from "./icons";
import { useAuth } from "@/components/Auth/AuthProvider";
import { auth as clientAuth } from "@/lib/firebase/config";
import { signOut } from "firebase/auth";

export function UserInfo() {
  const [isOpen, setIsOpen] = useState(false);
  const { user } = useAuth();
  const [imgError, setImgError] = useState(false);

  const handleSignOut = async () => {
    try {
      await signOut(clientAuth);
    } catch (error) {
      console.error("Error signing out:", error);
    }
  };

  const name = user?.displayName || "Admin";
  const email = user?.email || "admin@tophuntdpcontest.com";
  const img = user?.photoURL;

  return (
    <Dropdown isOpen={isOpen} setIsOpen={setIsOpen}>
      <DropdownTrigger className="rounded align-middle outline-none ring-primary ring-offset-2 focus-visible:ring-1 dark:ring-offset-gray-dark">
        <span className="sr-only">My Account</span>

        <figure className="flex items-center gap-3">
          <div className="size-12 rounded-full overflow-hidden bg-primary/10 border border-stroke dark:border-dark-3 flex items-center justify-center">
            {img && !imgError ? (
                <img
                    src={img}
                    className="size-full object-cover"
                    alt={name}
                    onError={() => setImgError(true)}
                />
            ) : (
                <span className="text-sm font-bold text-primary">{name.charAt(0).toUpperCase()}</span>
            )}
          </div>
          <figcaption className="flex items-center gap-1 font-medium text-dark dark:text-dark-6 max-[1024px]:sr-only">
            <span className="max-w-[100px] truncate">{name}</span>

            <ChevronUpIcon
              aria-hidden
              className={cn(
                "rotate-180 transition-transform",
                isOpen && "rotate-0",
              )}
              strokeWidth={1.5}
            />
          </figcaption>
        </figure>
      </DropdownTrigger>

      <DropdownContent
        className="border border-stroke bg-white shadow-md dark:border-dark-3 dark:bg-gray-dark min-[230px]:min-w-[17.5rem]"
        align="end"
      >
        <h2 className="sr-only">User information</h2>

        <figure className="flex items-center gap-2.5 px-5 py-3.5">
          <div className="size-12 rounded-full overflow-hidden bg-primary/10 border border-stroke dark:border-dark-3 flex items-center justify-center">
            {img && !imgError ? (
                <img
                    src={img}
                    className="size-full object-cover"
                    alt={name}
                    onError={() => setImgError(true)}
                />
            ) : (
                <span className="text-sm font-bold text-primary">{name.charAt(0).toUpperCase()}</span>
            )}
          </div>

          <figcaption className="space-y-1 text-base font-medium overflow-hidden">
            <div className="mb-2 leading-none text-dark dark:text-white truncate">
              {name}
            </div>

            <div className="leading-none text-gray-6 text-xs truncate">{email}</div>
          </figcaption>
        </figure>

        <hr className="border-[#E8E8E8] dark:border-dark-3" />

        <div className="p-2 text-base text-[#4B5563] dark:text-dark-6 [&>*]:cursor-pointer">
          <Link
            href={"/profile"}
            onClick={() => setIsOpen(false)}
            className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-[9px] hover:bg-gray-2 hover:text-dark dark:hover:bg-dark-3 dark:hover:text-white"
          >
            <UserIcon />
            <span className="mr-auto text-base font-medium">View profile</span>
          </Link>

          <Link
            href={"/pages/settings"}
            onClick={() => setIsOpen(false)}
            className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-[9px] hover:bg-gray-2 hover:text-dark dark:hover:bg-dark-3 dark:hover:text-white"
          >
            <SettingsIcon />
            <span className="mr-auto text-base font-medium">Account Settings</span>
          </Link>
        </div>

        <hr className="border-[#E8E8E8] dark:border-dark-3" />

        <div className="p-2 text-base text-[#4B5563] dark:text-dark-6">
          <button
            className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-[9px] hover:bg-gray-2 hover:text-dark dark:hover:bg-dark-3 dark:hover:text-white"
            onClick={handleSignOut}
          >
            <LogOutIcon />
            <span className="text-base font-medium">Log out</span>
          </button>
        </div>
      </DropdownContent>
    </Dropdown>
  );
}
