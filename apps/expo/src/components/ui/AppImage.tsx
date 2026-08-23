import React from 'react';
import { Image, type ImageProps } from 'expo-image';

/**
 * The app's standard image component — a thin wrapper over `expo-image` that
 * applies our caching defaults in one place.
 *
 * Why this exists: `cachePolicy` was set on only 3 of the 9 `expo-image` call
 * sites, so most images used the library default (`'disk'`). Disk caching alone
 * still re-reads and re-decodes the file on every mount, which is what made
 * scrolling feel heavy even though the bytes were already local. Centralising the
 * defaults means they cannot drift apart again.
 *
 * Three defaults, all overridable per call site:
 *
 *  - `cachePolicy: 'memory-disk'` — adds an in-memory layer on top of disk, so a
 *    row scrolling back into view is instant rather than a fresh decode.
 *  - `recyclingKey` derived from the source URI — in a recycled list (FlatList
 *    reuses row views) this is what stops a row briefly showing the PREVIOUS
 *    row's image before the new one loads.
 *  - `transition: 180` — a short cross-fade instead of a hard pop-in.
 */

/** Best-effort URI extraction, used only to derive a stable recycling key. */
function uriOf(source: ImageProps['source']): string | undefined {
  if (!source) return undefined;
  if (typeof source === 'string') return source;
  if (Array.isArray(source)) {
    const first = source[0];
    if (typeof first === 'string') return first;
    return typeof first === 'object' && first && 'uri' in first ? first.uri : undefined;
  }
  if (typeof source === 'object' && 'uri' in source) return source.uri ?? undefined;
  return undefined;
}

export const AppImage: React.FC<ImageProps> = ({
  source,
  cachePolicy,
  recyclingKey,
  transition,
  ...rest
}) => (
  <Image
    source={source}
    cachePolicy={cachePolicy ?? 'memory-disk'}
    // `?? uriOf(source)` rather than `||` so an explicit null (meaning "do not
    // reset on recycle") is preserved.
    recyclingKey={recyclingKey ?? uriOf(source)}
    transition={transition ?? 180}
    {...rest}
  />
);

export default AppImage;
