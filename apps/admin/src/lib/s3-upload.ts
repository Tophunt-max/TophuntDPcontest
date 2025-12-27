import { getFunctions, httpsCallable } from "firebase/functions";
import { getApp } from "firebase/app";

/**
 * Modern S3 Upload helper for Admin panel.
 * Uses the generic 'generatePresignedUrl' Cloud Function.
 */
export async function uploadPhotoToS3(file: File, folder: string = "admin-uploads") {
  const app = getApp();
  const functions = getFunctions(app, "asia-south1");
  const getPresignedUrl = httpsCallable(functions, "generatePresignedUrl");

  try {
    // 1. Get Presigned URL with folder context
    const result: any = await getPresignedUrl({ 
      fileType: file.type, 
      folder: folder 
    });
    const { uploadUrl, publicUrl } = result.data;

    // 2. Upload file to S3
    const uploadResponse = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Type": file.type,
      },
      body: file,
    });

    if (!uploadResponse.ok) {
      const errorText = await uploadResponse.text();
      console.error("S3 Put Error:", errorText);
      throw new Error("Failed to upload to S3");
    }

    return publicUrl;
  } catch (error) {
    console.error("S3 Upload Error:", error);
    throw error;
  }
}
