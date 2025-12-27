"use client";
import { EmailIcon, PasswordIcon } from "@/assets/icons";
import React, { useState } from "react";
import InputGroup from "../FormElements/InputGroup";
import { auth } from "@/lib/firebase/config";
import { signInWithEmailAndPassword } from "firebase/auth";
import { useRouter } from "next/navigation";

export default function SigninWithPassword() {
  const [data, setData] = useState({
    email: "",
    password: "",
  });

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setData({
      ...data,
      [e.target.name]: e.target.value,
    });
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const userCredential = await signInWithEmailAndPassword(auth, data.email, data.password);
      const idTokenResult = await userCredential.user.getIdTokenResult(true); // Force refresh to get latest claims
      
      if (idTokenResult.claims.role === 'admin') {
        router.push("/");
      } else {
        await auth.signOut();
        setError("Access denied. Admin privileges required.");
      }
    } catch (err: any) {
      console.error("Sign in error:", err);
      let message = "An error occurred during sign in.";
      
      if (
        err.code === 'auth/user-not-found' || 
        err.code === 'auth/wrong-password' || 
        err.code === 'auth/invalid-credential'
      ) {
        message = "Invalid email or password.";
      } else if (err.code === 'auth/too-many-requests') {
        message = "Too many failed attempts. Please try again later.";
      } else if (err.code === 'auth/network-request-failed') {
        message = "Network error. Please check your connection.";
      } else if (err.message) {
        message = err.message;
      }
      
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit}>
      {error && (
        <div className="mb-4 rounded-lg bg-red-50 p-4 text-center text-sm font-medium text-red-500 dark:bg-red-900/20">
          {error}
        </div>
      )}
      <InputGroup
        type="email"
        label="Email Address"
        className="mb-4 [&_input]:py-[15px] [&_input]:rounded-lg"
        placeholder="Enter your email"
        name="email"
        handleChange={handleChange}
        value={data.email}
        icon={<EmailIcon />}
      />

      <InputGroup
        type="password"
        label="Password"
        className="mb-6 [&_input]:py-[15px] [&_input]:rounded-lg"
        placeholder="Enter your password"
        name="password"
        handleChange={handleChange}
        value={data.password}
        icon={<PasswordIcon />}
      />

      <div className="mb-5">
        <button
          type="submit"
          disabled={loading}
          className="flex w-full cursor-pointer items-center justify-center gap-2 rounded-lg bg-primary p-4 font-semibold text-white transition hover:bg-opacity-90 disabled:cursor-not-allowed disabled:bg-opacity-50"
        >
          {loading ? (
            <span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-solid border-white border-t-transparent" />
          ) : (
            "Sign In"
          )}
        </button>
      </div>
    </form>
  );
}
