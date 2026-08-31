import React from 'react';
import { View, StyleSheet } from 'react-native';
import Svg, { Path } from 'react-native-svg';

/**
 * The Instagram-style verified badge.
 *
 * NOT a plain check-in-a-circle — that reads as Twitter/X. Instagram's mark is a
 * scalloped SEAL: a smooth rosette (a circle with soft rounded bumps) in its blue
 * (#0095F6) with a white tick. So this draws that shape rather than reusing an
 * icon-font glyph, and one shared renderer means every surface (profile, feed,
 * comments, chat, leaderboard, stories…) shows the identical mark.
 *
 * `verified` is the only input. It is set exclusively by the admin panel
 * (PATCH /admin/users/:id/profile → users.verified) and is deliberately NOT the
 * email/phone `emailVerified` flag, which is a different fact about
 * contactability and must never be conflated with this editorial blue check.
 */

/** Instagram blue. */
const SEAL_COLOR = '#0095F6';

/**
 * The scalloped seal outline, generated once on a 40×40 canvas.
 *
 * Built procedurally rather than as a hand-typed path so the rosette is exactly
 * symmetric: the radius follows `base + amp·cos(lobes·θ)`, a sinusoid that traces
 * a smooth flower/seal edge. Sampled finely enough to look round at the 12–20px
 * sizes the badge actually renders at. `LOBES = 8` and a gentle amplitude match
 * Instagram's soft scallop rather than a spiky burst.
 */
const SEAL_PATH = (() => {
  const cx = 20;
  const cy = 20;
  const base = 16.5;
  const amp = 2.2;
  const lobes = 8;
  const steps = 120;
  let d = '';
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * Math.PI * 2;
    const r = base + amp * Math.cos(lobes * t);
    const x = cx + r * Math.cos(t);
    const y = cy + r * Math.sin(t);
    d += `${i === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)} `;
  }
  return d + 'Z';
})();

export function VerifiedBadge({
  verified,
  size = 16,
  style,
}: {
  verified?: boolean | null;
  size?: number;
  style?: any;
}) {
  if (!verified) return null;
  return (
    <View
      style={[styles.wrap, style]}
      accessible
      accessibilityRole="image"
      accessibilityLabel="Verified account"
    >
      <Svg width={size} height={size} viewBox="0 0 40 40">
        <Path d={SEAL_PATH} fill={SEAL_COLOR} />
        {/* The tick, stroked with round caps so it stays clean at small sizes. */}
        <Path
          d="M13.2 20.4 L17.8 25 L27 14.8"
          stroke="#FFFFFF"
          strokeWidth={3.4}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      </Svg>
    </View>
  );
}

export default VerifiedBadge;

const styles = StyleSheet.create({
  wrap: { marginLeft: 4, justifyContent: 'center' },
});
