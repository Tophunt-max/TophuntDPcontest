"use client";

import Breadcrumb from "@/components/Breadcrumbs/Breadcrumb";
import Image from "next/image";
import { useState, useEffect } from "react";
import { CameraIcon } from "./_components/icons";
import { useAuth } from "@/components/Auth/AuthProvider";
import { doc, getDoc, updateDoc } from "firebase/firestore";
import { db } from "@/lib/firebase/config";
import { uploadToR2 } from "@/lib/r2-upload";
import { toast } from "react-hot-toast";

export default function Page() {
  const { user } = useAuth();
  const [loading, setLoading] = useState(false);
  
  const [data, setData] = useState({
    name: user?.displayName || "Admin User",
    email: user?.email || "",
    profilePhoto: user?.photoURL || "/images/user/user-03.png",
    coverPhoto: "/images/cover/cover-01.png",
    role: "System Administrator",
    about: "Managing the TopHunt DP Contest platform. Responsible for user management and content moderation."
  });

  // Fetch latest profile data from Firestore
  useEffect(() => {
    if (user?.uid) {
      const fetchProfile = async () => {
        try {
          const userDoc = await getDoc(doc(db, "users", user.uid));
          if (userDoc.exists()) {
            const userData = userDoc.data();
            setData(prev => ({
              ...prev,
              name: userData.fullName || userData.displayName || prev.name,
              profilePhoto: userData.profileImageUrl || userData.photoURL || prev.profilePhoto,
              coverPhoto: userData.coverImageUrl || prev.coverPhoto,
              about: userData.bio || prev.about,
              role: userData.role || prev.role
            }));
          }
        } catch (error) {
          console.error("Error fetching profile:", error);
        }
      };
      fetchProfile();
    }
  }, [user]);

  const handleImageUpload = async (file: File, type: 'profile' | 'cover') => {
    if (!user?.uid) return;
    
    setLoading(true);
    const toastId = toast.loading(`Uploading ${type} photo...`);
    
    try {
      const publicUrl = await uploadToR2(file, type === 'profile' ? 'profiles' : 'covers');
      
      // Update local state for immediate feedback
      setData(prev => ({
        ...prev,
        [type === 'profile' ? 'profilePhoto' : 'coverPhoto']: publicUrl
      }));

      // Update Firestore
      await updateDoc(doc(db, "users", user.uid), {
        [type === 'profile' ? 'profileImageUrl' : 'coverImageUrl']: publicUrl
      });

      toast.success(`${type.charAt(0).toUpperCase() + type.slice(1)} photo updated successfully!`, { id: toastId });
    } catch (error) {
      console.error("Upload error:", error);
      toast.error("Failed to upload image", { id: toastId });
    } finally {
      setLoading(false);
    }
  };

  const handleChange = async (e: any) => {
    const file = e.target?.files?.[0];
    if (!file) return;

    if (e.target.name === "profilePhoto") {
      await handleImageUpload(file, 'profile');
    } else if (e.target.name === "coverPhoto") {
      await handleImageUpload(file, 'cover');
    }
  };

  const isR2Url = (url: string) => url?.includes('media.tophunt.in');

  return (
    <div className="mx-auto w-full max-w-[970px]">
      <Breadcrumb pageName="Profile" />

      <div className="overflow-hidden rounded-[10px] bg-white shadow-1 dark:bg-gray-dark dark:shadow-card border border-stroke dark:border-dark-3">
        <div className="relative z-20 h-35 md:h-65 bg-gray-2 dark:bg-dark-2">
          {data.coverPhoto && (
            <Image
              src={data.coverPhoto}
              alt="profile cover"
              className="h-full w-full rounded-tl-[10px] rounded-tr-[10px] object-cover object-center"
              width={970}
              height={260}
              unoptimized={isR2Url(data.coverPhoto)}
            />
          )}
          <div className="absolute bottom-1 right-1 z-10 xsm:bottom-4 xsm:right-4">
            <label
              htmlFor="coverPhoto"
              className={`flex cursor-pointer items-center justify-center gap-2 rounded-lg bg-primary px-[15px] py-[5px] text-body-sm font-medium text-white hover:bg-opacity-90 ${loading ? 'opacity-50 cursor-not-allowed' : ''}`}
            >
              <input
                type="file"
                name="coverPhoto"
                id="coverPhoto"
                className="sr-only"
                onChange={handleChange}
                accept="image/png, image/jpg, image/jpeg"
                disabled={loading}
              />
              <CameraIcon />
              <span>{loading ? 'Uploading...' : 'Edit'}</span>
            </label>
          </div>
        </div>
        <div className="px-4 pb-6 text-center lg:pb-8 xl:pb-11.5">
          <div className="relative z-30 mx-auto -mt-22 h-30 w-full max-w-30 rounded-full bg-white/20 p-1 backdrop-blur sm:h-44 sm:max-w-[176px] sm:p-3">
            <div className="relative h-full w-full rounded-full overflow-hidden bg-white dark:bg-gray-dark">
                <Image
                  src={data?.profilePhoto || "/images/user/user-03.png"}
                  width={160}
                  height={160}
                  className="h-full w-full object-cover rounded-full"
                  alt="profile"
                  unoptimized={isR2Url(data?.profilePhoto)}
                />
              <label
                htmlFor="profilePhoto"
                className={`absolute bottom-0 right-0 flex size-8.5 cursor-pointer items-center justify-center rounded-full bg-primary text-white hover:bg-opacity-90 sm:bottom-2 sm:right-2 ${loading ? 'opacity-50' : ''}`}
              >
                <CameraIcon />
                <input
                  type="file"
                  name="profilePhoto"
                  id="profilePhoto"
                  className="sr-only"
                  onChange={handleChange}
                  accept="image/png, image/jpg, image/jpeg"
                  disabled={loading}
                />
              </label>
            </div>
          </div>
          <div className="mt-4">
            <h3 className="mb-1 text-heading-6 font-bold text-dark dark:text-white">
              {data?.name}
            </h3>
            <p className="font-medium text-primary">{data?.role}</p>
            <p className="text-sm text-gray-500 mt-1">{data?.email}</p>

            <div className="mx-auto max-w-[720px] mt-8">
              <h4 className="font-semibold text-dark dark:text-white border-b border-stroke dark:border-dark-3 pb-2">
                About Administrator
              </h4>
              <p className="mt-4 text-body-sm text-gray-6 dark:text-gray-4 leading-relaxed">
                {data?.about}
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
