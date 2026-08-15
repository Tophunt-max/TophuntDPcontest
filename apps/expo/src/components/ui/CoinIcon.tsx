import React from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import Coins from 'lucide-react-native/icons/coins';

/**
 * CoinIcon — the SINGLE, app-wide coin symbol.
 *
 * Use this EVERYWHERE a Dpcoin amount/balance is shown so the coin looks
 * identical across the app (previously coins were drawn with a lightning bolt,
 * a wallet, FontAwesome coins, or nothing). It's an SVG (lucide) so it renders
 * on web/Android/iOS and adapts to any `color`.
 */
export const COIN_COLOR = '#FFB300';

export interface CoinIconProps {
  size?: number;
  color?: string;
  style?: StyleProp<ViewStyle>;
}

export function CoinIcon({ size = 16, color = COIN_COLOR, style }: CoinIconProps) {
  return <Coins size={size} color={color} style={style} />;
}

export default CoinIcon;
