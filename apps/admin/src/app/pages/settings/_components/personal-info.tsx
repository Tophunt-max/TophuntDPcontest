"use client";

import {
  CallIcon,
  EmailIcon,
  PencilSquareIcon,
  UserIcon,
} from "@/assets/icons";
import InputGroup from "@/components/FormElements/InputGroup";
import { TextAreaGroup } from "@/components/FormElements/InputGroup/text-area";
import { ShowcaseSection } from "@/components/Layouts/showcase-section";
import { useAuth } from "@/components/Auth/AuthProvider";
import { useState, useEffect } from "react";
import { updateProfile } from "firebase/auth";

export function PersonalInfoForm() {
  const { user } = useAuth();
  const [loading, setLoading] = useState(false);
  const [formData, setFormData] = useState({
    fullName: "",
    email: "",
    username: "",
    bio: "System Administrator for TopHunt DP Contest."
  });

  useEffect(() => {
    if (user) {
      setFormData(prev => ({
        ...prev,
        fullName: user.displayName || "",
        email: user.email || "",
      }));
    }
  }, [user]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    
    setLoading(true);
    try {
      await updateProfile(user, {
        displayName: formData.fullName
      });
      alert("Profile updated successfully!");
    } catch (error: any) {
      alert("Error updating profile: " + error.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <ShowcaseSection title="Personal Information" className="!p-7">
      <form onSubmit={handleSubmit}>
        <div className="mb-5.5 flex flex-col gap-5.5 sm:flex-row">
          <InputGroup
            className="w-full sm:w-1/2"
            type="text"
            name="fullName"
            label="Full Name"
            placeholder="Admin Name"
            value={formData.fullName}
            handleChange={(e) => setFormData({...formData, fullName: e.target.value})}
            icon={<UserIcon />}
            iconPosition="left"
            height="sm"
          />

          <InputGroup
            className="w-full sm:w-1/2"
            type="text"
            name="phoneNumber"
            label="Phone Number"
            placeholder="N/A"
            defaultValue={user?.phoneNumber || ""}
            icon={<CallIcon />}
            iconPosition="left"
            height="sm"
            disabled
          />
        </div>

        <InputGroup
          className="mb-5.5"
          type="email"
          name="email"
          label="Email Address"
          placeholder="admin@example.com"
          value={formData.email}
          icon={<EmailIcon />}
          iconPosition="left"
          height="sm"
          disabled
        />

        <TextAreaGroup
          className="mb-5.5"
          label="BIO"
          placeholder="Write your bio here"
          icon={<PencilSquareIcon />}
          defaultValue={formData.bio}
          // Note: TextAreaGroup might have similar prop name issues, but defaultValue is safer if it's not controlled
        />

        <div className="flex justify-end gap-3">
          <button
            className="rounded-lg border border-stroke px-6 py-[7px] font-medium text-dark hover:shadow-1 dark:border-dark-3 dark:text-white"
            type="button"
          >
            Cancel
          </button>

          <button
            className="rounded-lg bg-primary px-6 py-[7px] font-medium text-gray-2 hover:bg-opacity-90 disabled:bg-opacity-50"
            type="submit"
            disabled={loading}
          >
            {loading ? "Saving..." : "Save"}
          </button>
        </div>
      </form>
    </ShowcaseSection>
  );
}
