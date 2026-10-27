import React, { useEffect, useMemo, useState } from 'react';
import { PixelRatio } from 'react-native';
import { Image, type ImageProps } from 'expo-image';
import { originalImageUrl, previewImageUrl, responsiveImageUrl } from '@/src/lib/imageVariants';

/**
 * The app's standard image component — a thin wrapper over `expo-image` that
 * applies our caching defaults and responsive sizing in one place.
 *
 * Why this exists: `cachePolicy` was set on only 3 of the 9 `expo-image` call
 * sites, so most images used the library default (`'disk'`). Disk caching alone
 * still re-reads and re-decodes the file on every mount, which is what made
 * scrolling feel heavy even though the bytes were already local. Centralising the
 * defaults means they cannot drift apart again.
 *
 * Defaults, all overridable per call site:
 *
 *  - `cachePolicy: 'memory-disk'` — adds an in-memory layer on top of disk, so a
 *    row scrolling back into view is instant rather than a fresh decode.
 *  - `recyclingKey` derived from the source URI — in a recycled list (FlatList
 *    reuses row views) this is what stops a row briefly showing the PREVIOUS
 *    row's image before the new one loads.
 *  - `transition: 180` — a short cross-fade instead of a hard pop-in.
 *
 * Responsive sizing (`displayWidth`): pass the width the image is drawn at, in
 * points, and one of our media urls is loaded as a Cloudflare variant of that
 * size × the screen density (src/lib/imageVariants.ts), with a small preview of
 * the same image underneath while it loads. If the variant fails, the ORIGINAL
 * is tried once before `onError` fires, so a transformation outage degrades to
 * full-size images, never to blank ones. Without `displayWidth` the url is used
 * exactly as given.
 */

type Props = ImageProps & {
  /** Rendered width in points. Enables the responsive Cloudflare variant. */
  displayWidth?: number;
  /** Skip the low-res preview (e.g. tiny thumbnails, blurred backdrops). */
  noPreview?: boolean;
};

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

export const AppImage: React.FC<Props> = ({
  source,
  cachePolicy,
  recyclingKey,
  transition,
  displayWidth,
  noPreview,
  placeholder,
  onError,
  ...rest
}) => {
  const rawUri = uriOf(source);
  // Only plain `{ uri }` / string sources are resized; arrays, local requires
  // and refs pass through untouched.
  const resizable = !!rawUri && !Array.isArray(source) && (typeof source === 'string' || typeof source === 'object');
  const dpr = PixelRatio.get();
  const variant = resizable && displayWidth ? responsiveImageUrl(rawUri, displayWidth, dpr) : rawUri;

  // Fall back to the original once if the variant fails.
  const [useOriginal, setUseOriginal] = useState(false);
  useEffect(() => setUseOriginal(false), [rawUri]);
  const finalUri = useOriginal ? originalImageUrl(rawUri) : variant;
  const isVariant = !!variant && variant !== rawUri;

  const finalSource = useMemo(() => {
    if (!resizable || !finalUri || finalUri === rawUri) return source;
    return typeof source === 'object' && source && !Array.isArray(source)
      ? { ...(source as object), uri: finalUri }
      : finalUri;
  }, [resizable, finalUri, rawUri, source]);

  const preview =
    placeholder ??
    (!noPreview && isVariant && !useOriginal && displayWidth ? previewImageUrl(rawUri, displayWidth, dpr) : null);

  return (
    <Image
      source={finalSource}
      cachePolicy={cachePolicy ?? 'memory-disk'}
      // `?? uriOf(source)` rather than `||` so an explicit null (meaning "do not
      // reset on recycle") is preserved. Keyed on the stored url, not the
      // variant, so a density change does not count as a different row.
      recyclingKey={recyclingKey ?? rawUri}
      transition={transition ?? 180}
      placeholder={preview ?? undefined}
      placeholderContentFit={rest.placeholderContentFit ?? rest.contentFit}
      onError={(e) => {
        if (isVariant && !useOriginal) {
          setUseOriginal(true);
          return;
        }
        onError?.(e);
      }}
      {...rest}
    />
  );
};

/**
 * The exact url `<AppImage displayWidth={w}>` will load for `url`, for callers
 * that prefetch: warming any other url would download a second copy.
 */
export function displayImageUrl(url: string | null | undefined, displayWidth: number): string | null | undefined {
  return responsiveImageUrl(url, displayWidth, PixelRatio.get());
}

export default AppImage;
