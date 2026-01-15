import * as FileSystem from 'expo-file-system';
import * as ImageManipulator from 'expo-image-manipulator';
import { Platform } from 'react-native';

const STATUS_UPLOAD_URL = 'https://upload.tophunt.in/upload-status';

export interface StatusUploadResult {
  success: boolean;
  statusId: string;
  mediaUrl: string;
  type: 'photo' | 'video';
  expiresAt: number;
  objectKey: string;
}

export class StatusMediaService {
  /**
   * High-performance status upload using Native FileSystem (Best for Expo)
   */
  static async uploadStatus(
    uri: string,
    userId: string,
    isVideo: boolean,
    onProgress?: (progress: number) => void
  ): Promise<StatusUploadResult> {
    try {
      let uploadUri = uri;

      // 1. Optimize Photos (Skip for Videos)
      if (!isVideo) {
        try {
          const manipResult = await ImageManipulator.manipulateAsync(
            uri,
            [{ resize: { width: 1080 } }],
            { compress: 0.8, format: ImageManipulator.SaveFormat.WEBP }
          );
          uploadUri = manipResult.uri;
        } catch (e) {
          console.warn("Optimization failed, using original", e);
        }
      }

      console.log(`[StatusMediaService] Starting upload via FileSystem... URI: ${uploadUri}`);

      // 2. Prepare Upload Task (Safe Handling for Web & Native)
      if (Platform.OS === 'web') {
        // Fallback for Web (Since FileSystem is native only)
        const response = await fetch(uploadUri);
        const blob = await response.blob();
        
        const formData = new FormData();
        formData.append('file', blob);
        formData.append('userId', userId);
        formData.append('type', isVideo ? 'status_video' : 'status_photo');

        return new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open('POST', STATUS_UPLOAD_URL);
          xhr.setRequestHeader('Accept', 'application/json');
          
          xhr.upload.onprogress = (event) => {
             if (event.lengthComputable && onProgress) {
               onProgress(Math.round((event.loaded / event.total) * 100));
             }
          };

          xhr.onload = () => {
             if (xhr.status >= 200 && xhr.status < 300) {
                try {
                   const result = JSON.parse(xhr.responseText);
                   if (result.success) resolve(result);
                   else reject(new Error(result.error || 'Server returned false success'));
                } catch (e) {
                   reject(new Error(`Invalid JSON response: ${xhr.responseText}`));
                }
             } else {
                reject(new Error(`Server Error: ${xhr.status} ${xhr.responseText}`));
             }
          };

          xhr.onerror = () => reject(new Error('Network request failed'));
          xhr.send(formData);
        });

      } else {
        // NATIVE IMPLEMENTATION (Android / iOS)
        const uploadType = FileSystem.FileSystemUploadType ? FileSystem.FileSystemUploadType.MULTIPART : 1; 

        const uploadTask = FileSystem.createUploadTask(
          STATUS_UPLOAD_URL,
          uploadUri,
          {
            fieldName: 'file',
            httpMethod: 'POST',
            uploadType: uploadType, 
            headers: {
              'Accept': 'application/json',
            },
            parameters: {
              userId: userId,
              type: isVideo ? 'status_video' : 'status_photo',
            },
          },
          (data) => {
            if (onProgress && data.totalBytesSent && data.totalBytesExpectedToSend) {
              const progress = (data.totalBytesSent / data.totalBytesExpectedToSend) * 100;
              onProgress(Math.round(progress));
            }
          }
        );

        const response = await uploadTask.uploadAsync();

        if (!response || !response.body) {
          throw new Error(`Upload failed with status ${response?.status}`);
        }

        if (response.status >= 200 && response.status < 300) {
          const result = JSON.parse(response.body);
          if (result.success) {
            return result;
          } else {
            throw new Error(result.error || 'Server returned false success');
          }
        } else {
          throw new Error(`Server Error: ${response.body}`);
        }
      }

    } catch (error: any) {
      console.error("[StatusMediaService] Critical Failure:", error);
      throw error;
    }
  }
}
