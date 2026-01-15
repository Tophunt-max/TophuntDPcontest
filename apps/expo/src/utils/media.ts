/**
 * Converts any media URL (R2 dev or Upload domain) to the Optimized Streaming Domain.
 * This ensures we hit the Cloudflare CDN (Edge) and handle Range requests correctly.
 */
export const getOptimizedMediaUrl = (url: string): string => {
  if (!url) return '';
  
  // Skip local files or data URIs
  if (url.startsWith('file://') || url.startsWith('data:') || url.startsWith('content://')) {
    return url;
  }

  const STREAMING_DOMAIN = 'stream.tophunt.in';
  
  try {
    // If it's already a full URL
    if (url.startsWith('http')) {
      const urlObj = new URL(url);
      
      // If it's already on the streaming domain, just return it
      if (urlObj.hostname === STREAMING_DOMAIN) return url;

      // List of domains we want to migrate to the streaming domain
      const domainsToMigrate = [
        'upload.tophunt.in',
        'media.tophunt.in',
        'tophunt.in'
      ];

      const shouldMigrate = domainsToMigrate.some(d => urlObj.hostname === d) || 
                           urlObj.hostname.includes('r2.dev');

      if (shouldMigrate) {
        // Construct new URL using the streaming domain but keeping path and search params
        return `https://${STREAMING_DOMAIN}${urlObj.pathname}${urlObj.search}`;
      }
      
      return url;
    }

    // Handle relative paths
    if (url.startsWith('/')) {
      return `https://${STREAMING_DOMAIN}${url}`;
    }

    return url;
  } catch (e) {
    return url;
  }
};
