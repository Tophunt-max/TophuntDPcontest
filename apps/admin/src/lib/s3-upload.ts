import { callApi } from "@/services/firebase/functions"; // Use centralized callApi helper

/**
 * Modern S3 Upload helper for Admin panel.
 * Uses the consolidated API with 'getPresignedUrl' action.
 */
export async function uploadPhotoToS3(file: File, folder: string = "admin-uploads") {
  try {
    // 1. Get Presigned URL using the new consolidated API
    const result: any = await callApi('getPresignedUrl', { 
      fileType: file.type, 
      folder: folder 
    });
    
    const { uploadUrl, publicUrl } = result;

    if (!uploadUrl) {
        throw new Error("No upload URL received from server.");
    }

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
