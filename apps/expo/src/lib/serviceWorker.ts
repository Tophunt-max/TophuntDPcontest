/** Native: there is no service worker (see serviceWorker.web.ts). */
export function registerServiceWorker(): void {}

/** Native: images are cached by expo-image, cleared from Settings (appCache.ts). */
export async function clearOfflineMedia(): Promise<void> {}
