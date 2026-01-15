/**
 * Cloudflare R2 Upload for Admin Panel
 * Using the custom domain: upload.tophunt.in
 * Updated to return the optimized CDN domain for viewing.
 */

const UPLOAD_URL = 'https://upload.tophunt.in/upload';
const CDN_DOMAIN = 'stream.tophunt.in';

export async function uploadToR2(
  file: File, 
  folder: string = 'general', 
  userId: string = 'admin'
) {
  try {
    console.log(`[AdminR2Upload] Uploading ${file.name} to ${folder}...`);

    const formData = new FormData();
    formData.append('file', file);
    formData.append('userId', userId);
    formData.append('type', folder);
    formData.append('size', 'original');

    const response = await fetch(UPLOAD_URL, {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Upload failed: ${errorText}`);
    }

    const data = await response.json();
    
    // The worker returns a URL like https://stream.tophunt.in/folder/admin/size.jpg
    // or https://upload.tophunt.in/...
    // We ensure it points to our optimized CDN domain for global delivery.
    let finalUrl = data.url;
    if (finalUrl.includes('upload.tophunt.in')) {
      finalUrl = finalUrl.replace('upload.tophunt.in', CDN_DOMAIN);
    } else if (finalUrl.includes('media.tophunt.in')) {
      finalUrl = finalUrl.replace('media.tophunt.in', CDN_DOMAIN);
    }

    console.log(`[AdminR2Upload] Success: ${finalUrl}`);
    return finalUrl;

  } catch (error) {
    console.error("[AdminR2Upload] Error:", error);
    throw error;
  }
}
