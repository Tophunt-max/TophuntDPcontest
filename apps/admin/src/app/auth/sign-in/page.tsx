import Signin from "@/components/Auth/Signin";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Sign in | Admin Panel",
};

export default function SignIn() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-2 px-4 py-8 dark:bg-[#020d1a]">
      <Signin />
    </div>
  );
}
