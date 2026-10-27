import React from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import Svg, { Path } from 'react-native-svg';

/**
 * DiamondIcon — the app-wide symbol for Diamonds, the play-only balance.
 *
 *   Diamond  (this icon)  contest entry fees; from coin packages and free
 *                         rewards; never withdrawable
 *   DP coin  (CoinIcon)   contest prizes; the only balance that is withdrawn
 *
 * Use it everywhere a Diamond amount is shown so the two balances can be told
 * apart at a glance. A cut gem on a 24×24 canvas: the outline is filled with
 * `color`, and the facets are white / black overlays at low opacity, so one
 * colour prop gives a shaded gem on any background (cyan on light cards, white
 * on the coloured wallet cards).
 */
export const DIAMOND_COLOR = '#22D3EE';

/** Outline: flat table on top, girdle at y=9, pavilion point at the bottom. */
const OUTLINE = 'M6 3 H18 L22 9 L12 21 L2 9 Z';

/** [path, overlay colour, opacity] per facet. */
const FACETS: [string, string, number][] = [
  ['M6 3 L12 3 L9 9 Z', '#FFFFFF', 0.55], // crown, upper left (brightest)
  ['M12 3 L18 3 L15 9 Z', '#FFFFFF', 0.35],
  ['M2 9 L6 3 L9 9 Z', '#FFFFFF', 0.25],
  ['M12 3 L15 9 L9 9 Z', '#FFFFFF', 0.15],
  ['M18 3 L22 9 L15 9 Z', '#000000', 0.12],
  ['M2 9 L9 9 L12 21 Z', '#FFFFFF', 0.2], // pavilion
  ['M15 9 L22 9 L12 21 Z', '#000000', 0.22],
];

export interface DiamondIconProps {
  size?: number;
  color?: string;
  style?: StyleProp<ViewStyle>;
}

export function DiamondIcon({ size = 16, color = DIAMOND_COLOR, style }: DiamondIconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" style={style as any} accessibilityLabel="Diamond">
      <Path d={OUTLINE} fill={color} />
      {FACETS.map(([d, fill, opacity]) => (
        <Path key={d} d={d} fill={fill} fillOpacity={opacity} />
      ))}
      <Path d={OUTLINE} fill="none" stroke={color} strokeWidth={1.2} strokeLinejoin="round" />
    </Svg>
  );
}

export default DiamondIcon;
