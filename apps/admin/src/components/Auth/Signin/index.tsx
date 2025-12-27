"use client";

import React from "react";
import SigninWithPassword from "../SigninWithPassword";
import Image from "next/image";

export default function Signin() {
  return (
    <div className="mx-auto w-full max-w-[480px]">
      <div className="mb-10 text-center">
        <div className="mb-5.5 inline-block">
          <Image
            className="hidden dark:block"
            src={"/images/logo/logo.svg"}
            alt="Logo"
            width={176}
            height={32}
          />
          <Image
            className="dark:hidden"
            src={"/images/logo/logo-dark.svg"}
            alt="Logo"
            width={176}
            height={32}
          />
        </div>
        <h2 className="mb-2 text-2xl font-bold text-dark dark:text-white sm:text-title-xl2">
          Sign In to Admin
        </h2>
        <p className="font-medium">
          Enter your credentials to access the dashboard
        </p>
      </div>

      <div className="rounded-xl border border-stroke bg-white p-4 shadow-default dark:border-strokedark dark:bg-boxdark sm:p-8.5">
        <SigninWithPassword />
      </div>
    </div>
  );
}
