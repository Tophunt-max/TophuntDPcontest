import React, { useState } from 'react';
import { View, Text, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { Image } from 'expo-image';

/**
 * Avatar with a locally-rendered initials fallback.
 *
 * Replaces the `ui-avatars.com` / `i.pravatar.cc` fallbacks that used to be
 * scattered across the app (MEDIA_MIGRATION_PLAN.md §1a). Two reasons that
 * mattered beyond tidiness:
 *
 *  - those URLs embed the user's name, so every avatar render leaked a username
 *    to a third party;
 *  - a remote fallback fails exactly when the network is bad, which is precisely
 *    when a fallback is needed.
 *
 * Rendering initials locally is instant, offline-safe and leaks nothing. The
 * background colour is derived from the name so a given user keeps a stable
 * colour across screens (the old `&background=random` was random per request).
 */

const PALETTE = [
  '#FF4D67',
  '#5B8DEF',
  '#2BB673',
  '#F5A623',
  '#9B51E0',
  '#00B8D9',
  '#EB5757',
  '#6FCF97',
];

/** Up to two initials: "Asha Verma" -> "AV", "asha" -> "AS", "" -> "?". */
export function initialsFor(name?: string | null): string {
  const parts = String(name ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Stable per-name colour (FNV-ish hash so it does not change between renders). */
export function avatarColorFor(name?: string | null): string {
  const s = String(name ?? '');
  let hash = 0;
  for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) | 0;
  return PALETTE[Math.abs(hash) % PALETTE.length];
}

export interface AvatarProps {
  /** Remote avatar. Null/empty renders the initials fallback. */
  uri?: string | null;
  /** Used for the initials and the fallback colour. */
  name?: string | null;
  /** Width/height in px. With `fill`, used only to scale the initials. */
  size?: number;
  /**
   * Stretch to the parent instead of using `size`. For call sites where an
   * outer wrapper already owns the dimensions, border and clipping.
   */
  fill?: boolean;
  /** Border, margin, absolute positioning, etc. */
  style?: StyleProp<ViewStyle>;
  /** Override the default fully-round shape. */
  borderRadius?: number;
}

export const Avatar: React.FC<AvatarProps> = ({
  uri,
  name,
  size = 40,
  fill = false,
  style,
  borderRadius,
}) => {
  // A broken/expired remote URL should degrade to initials rather than a blank
  // box, so track load failures per-instance.
  const [failed, setFailed] = useState(false);

  const box: ViewStyle = fill
    ? { width: '100%', height: '100%', borderRadius: borderRadius ?? 0 }
    : { width: size, height: size, borderRadius: borderRadius ?? size / 2 };
  const showImage = !!uri && !failed;

  if (showImage) {
    return (
      <Image
        source={{ uri: uri as string }}
        style={[box, style as any]}
        contentFit="cover"
        transition={150}
        onError={() => setFailed(true)}
      />
    );
  }

  return (
    <View style={[box, styles.fallback, { backgroundColor: avatarColorFor(name) }, style]}>
      <Text
        style={[styles.initials, { fontSize: Math.max(10, size * 0.4) }]}
        numberOfLines={1}
        allowFontScaling={false}
      >
        {initialsFor(name)}
      </Text>
    </View>
  );
};

const styles = StyleSheet.create({
  fallback: {
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  initials: {
    color: '#FFFFFF',
    fontFamily: 'Urbanist-Bold',
    includeFontPadding: false,
    textAlign: 'center',
  },
});

export default Avatar;
