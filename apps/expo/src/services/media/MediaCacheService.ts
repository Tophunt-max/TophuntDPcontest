import * as FileSystem from 'expo-file-system';
import { Platform } from 'react-native';
import { getOptimizedMediaUrl } from '../../utils/media';

const CACHE_FOLDER = `${FileSystem.cacheDirectory}media_cache/`;
const downloadingFiles = new Map<string, Promise<string>>();

const ensureDirExists = async () => {
    try {
        const dirInfo = await FileSystem.getInfoAsync(CACHE_FOLDER);
        if (!dirInfo.exists) {
            await FileSystem.makeDirectoryAsync(CACHE_FOLDER, { intermediates: true });
        }
    } catch (e) {
        console.error('MediaCacheService: Error creating cache directory', e);
    }
};

const getFileName = (url: string) => {
    if (!url) return '';
    
    // Use the path part of the URL to generate a name, ignoring query params that might change
    try {
        const urlObj = new URL(url);
        const path = urlObj.pathname;
        const lastPart = path.split('/').pop() || 'file';
        
        // Simple hash of the full URL (minus search params to keep it stable) to ensure uniqueness
        const stableUrl = `${urlObj.hostname}${urlObj.pathname}`;
        let hash = 0;
        for (let i = 0; i < stableUrl.length; i++) {
            hash = ((hash << 5) - hash) + stableUrl.charCodeAt(i);
            hash |= 0;
        }
        return `${Math.abs(hash)}_${lastPart}`;
    } catch (e) {
        // Fallback for non-standard URLs
        return `cached_${Date.now()}`;
    }
};

/**
 * Gets a cached version of a media file.
 * If not cached, it returns the original (optimized) URL and starts a background prefetch.
 */
export const getCachedMedia = async (rawUrl: string): Promise<string> => {
    if (Platform.OS === 'web' || !rawUrl || !rawUrl.startsWith('http')) return rawUrl;
    
    // Always use the optimized CDN URL for caching to maintain consistency
    const url = getOptimizedMediaUrl(rawUrl);
    
    try {
        await ensureDirExists();
        const fileName = getFileName(url);
        const fileUri = `${CACHE_FOLDER}${fileName}`;
        const fileInfo = await FileSystem.getInfoAsync(fileUri);

        if (fileInfo.exists) {
            return fileUri;
        }

        // If not exists, we return the CDN URL for immediate playback/viewing
        // but start a prefetch for future use so next time it's local
        prefetchMedia(url);
        return url;
    } catch (e) {
        return url;
    }
};

/**
 * Prefetches media and saves it to local disk.
 */
export const prefetchMedia = async (rawUrl: string): Promise<string | null> => {
    if (Platform.OS === 'web' || !rawUrl || !rawUrl.startsWith('http')) return null;

    const url = getOptimizedMediaUrl(rawUrl);

    try {
        await ensureDirExists();
        const fileName = getFileName(url);
        const fileUri = `${CACHE_FOLDER}${fileName}`;
        const fileInfo = await FileSystem.getInfoAsync(fileUri);

        if (fileInfo.exists) {
            return fileUri;
        }

        if (downloadingFiles.has(fileUri)) {
            return downloadingFiles.get(fileUri)!;
        }

        const downloadPromise = (async () => {
            try {
                const result = await FileSystem.downloadAsync(url, fileUri);
                downloadingFiles.delete(fileUri);
                return result.uri;
            } catch (e) {
                downloadingFiles.delete(fileUri);
                return url;
            }
        })();

        downloadingFiles.set(fileUri, downloadPromise);
        return downloadPromise;
    } catch (e) {
        return null;
    }
};

export const clearMediaCache = async () => {
    try {
        const dirInfo = await FileSystem.getInfoAsync(CACHE_FOLDER);
        if (dirInfo.exists) {
            await FileSystem.deleteAsync(CACHE_FOLDER, { idempotent: true });
        }
        downloadingFiles.clear();
    } catch (e) {
        console.error('MediaCacheService: Error clearing cache', e);
    }
};
