import * as ImageManipulator from 'expo-image-manipulator';
import { Platform } from 'react-native';

const WORKER_URL = 'https://upload.tophunt.in/upload';

export type CloudflareUploadType = 'profiles' | 'stories';

export interface PhotoDerivatives {
  small: string;
  medium: string;
  full: string;
}

export class CloudflareMediaService {
  /**
   * Client-side optimization and multi-size upload to JPEG (Max Compatibility)
   */
  static async uploadProfileImage(
    uri: string, 
    userId: string,
    onProgress?: (progress: number) => void
  ): Promise<PhotoDerivatives> {
    try {
      console.log(`[CloudflareMediaService] Optimizing image to JPEG for compatibility...`);

      // We'll upload the 'medium' size as the primary one for now to save bandwidth, 
      // or we can upload full and let the worker handle derivatives if it did that.
      // But the current performUpload does one upload at a time.
      
      const sizes = [
        { name: 'small', width: 150, quality: 0.6 },
        { name: 'medium', width: 600, quality: 0.7 },
        { name: 'full', width: 1080, quality: 0.8 },
      ];

      // For progress tracking, we'll track the 'full' or 'medium' one primarily if needed, 
      // but let's simplify and just perform the uploads.
      
      const uploadPromises = sizes.map(async (size) => {
        const manipResult = await ImageManipulator.manipulateAsync(
          uri,
          [{ resize: { width: size.width } }],
          { compress: size.quality, format: ImageManipulator.SaveFormat.JPEG }
        );

        // We only report progress for the 'full' size to avoid jumping progress bar
        return this.performUpload(
            manipResult.uri, 
            userId, 
            'profiles', 
            size.name, 
            size.name === 'full' ? onProgress : undefined
        );
      });

      const [smallUrl, mediumUrl, fullUrl] = await Promise.all(uploadPromises);

      return {
        small: smallUrl,
        medium: mediumUrl,
        full: fullUrl,
      };

    } catch (error) {
      console.error("[CloudflareMediaService] Optimization/Upload failed:", error);
      throw error;
    }
  }

  private static async performUpload(
    uri: string, 
    userId: string, 
    type: string, 
    size: string,
    onProgress?: (progress: number) => void
  ): Promise<string> {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        const formData = new FormData();
        const filename = `img_${size}_${Date.now()}.jpg`;

        // FIXED: Added check to ensure onProgress is a function
        if (onProgress && typeof onProgress === 'function') {
            xhr.upload.addEventListener('progress', (event) => {
                if (event.lengthComputable) {
                    const progress = Math.round((event.loaded / event.total) * 100);
                    // Double check before calling
                    if (typeof onProgress === 'function') {
                        onProgress(progress);
                    }
                }
            });
        }

        xhr.onreadystatechange = () => {
            if (xhr.readyState === 4) {
                if (xhr.status >= 200 && xhr.status < 300) {
                    try {
                        const result = JSON.parse(xhr.responseText);
                        if (result.success) {
                            resolve(result.url);
                        } else {
                            reject(new Error(result.error || 'Upload failed'));
                        }
                    } catch (e) {
                        reject(new Error('Failed to parse upload response'));
                    }
                } else {
                    reject(new Error(`Cloudflare Upload failed (${xhr.status}): ${xhr.responseText}`));
                }
            }
        };

        xhr.onerror = () => reject(new Error('Network error during upload'));

        if (Platform.OS === 'web') {
            // Fetch blob for web
            fetch(uri).then(res => res.blob()).then(blob => {
                formData.append('file', blob, filename);
                this.appendMetadataAndSend(xhr, formData, userId, type, size);
            }).catch(reject);
        } else {
            formData.append('file', {
                uri: Platform.OS === 'ios' ? uri.replace('file://', '') : uri,
                type: 'image/jpeg',
                name: filename,
            } as any);
            this.appendMetadataAndSend(xhr, formData, userId, type, size);
        }
    });
  }

  private static appendMetadataAndSend(xhr: XMLHttpRequest, formData: FormData, userId: string, type: string, size: string) {
    formData.append('userId', userId);
    formData.append('type', type);
    formData.append('size', size);

    xhr.open('POST', WORKER_URL);
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.send(formData);
  }

  // Backward compatibility
  static async uploadImage(
    uri: string, 
    userId: string, 
    type: CloudflareUploadType,
    onProgress?: (progress: number) => void
  ): Promise<string> {
      // For stories/contests, we might want higher quality than profile pics
      // but let's use the same optimized flow.
      const result = await this.uploadProfileImage(uri, userId, onProgress);
      return result.medium; // Use medium as the standard return
  }
}
