import React from 'react';
import { View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { CoinIcon } from '@/src/components/ui/CoinIcon';

/**
 * A gold Dpcoin medallion: the app's coin symbol (CoinIcon) struck on a minted
 * coin face. Plain Views + one SVG, so it captures identically on native
 * (view-shot) and web (html-to-image) inside the shareable winner card.
 */
export function CoinMedallion({ size }: { size: number }) {
  const rim = Math.max(2, Math.round(size * 0.07));
  const inner = size - rim * 2;
  return (
    <LinearGradient
      colors={['#FFF4B0', '#FFC107', '#C98600']}
      start={{ x: 0.15, y: 0 }}
      end={{ x: 0.85, y: 1 }}
      style={{ width: size, height: size, borderRadius: size / 2, alignItems: 'center', justifyContent: 'center' }}
    >
      <LinearGradient
        colors={['#FFD54F', '#FFB300', '#F59E0B']}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={{
          width: inner,
          height: inner,
          borderRadius: inner / 2,
          alignItems: 'center',
          justifyContent: 'center',
          borderWidth: Math.max(1, Math.round(size * 0.03)),
          borderColor: 'rgba(255,248,214,0.85)',
          overflow: 'hidden',
        }}
      >
        {/* Shine */}
        <View
          style={{
            position: 'absolute',
            top: inner * 0.08,
            left: inner * 0.16,
            width: inner * 0.42,
            height: inner * 0.2,
            borderRadius: inner * 0.2,
            backgroundColor: 'rgba(255,255,255,0.38)',
            transform: [{ rotate: '-24deg' }],
          }}
        />
        <CoinIcon size={Math.round(inner * 0.56)} color="#7A4B00" />
      </LinearGradient>
    </LinearGradient>
  );
}

export default CoinMedallion;
