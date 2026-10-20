import { useMemo } from 'react';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { Colors } from '@/constants/theme';

/** Brand + surface palette shared by every Explore component (light / dark). */
export const BRAND = '#FF4D67';
export const BRAND_GRAD: [string, string] = ['#FF4D67', '#8B5CF6'];
export const PHOTO_GRAD: [string, string] = ['#FF4D67', '#FF7A45'];
export const VIDEO_GRAD: [string, string] = ['#6A5AE0', '#8B5CF6'];
export const GOLD = '#F59E0B';
export const PAD = 20;

export const gradForType = (t?: string | null): [string, string] => (t === 'video' ? VIDEO_GRAD : PHOTO_GRAD);
export const colorForType = (t?: string | null): string => (t === 'video' ? '#6A5AE0' : BRAND);

export interface ExplorePalette {
  isDark: boolean;
  bg: string;
  card: string;
  chip: string;
  text: string;
  sub: string;
  border: string;
  skeleton: string;
}

export function useExplorePalette(): ExplorePalette {
  const isDark = useColorScheme() === 'dark';
  return useMemo(
    () => ({
      isDark,
      bg: isDark ? Colors.dark.background : Colors.light.background,
      card: isDark ? '#16171E' : '#FFFFFF',
      chip: isDark ? '#1B1D26' : '#F1F2F6',
      text: isDark ? '#FFFFFF' : '#121212',
      sub: isDark ? '#8B8F9A' : '#7A7A80',
      border: isDark ? '#23262F' : '#EEEEF2',
      skeleton: isDark ? '#22252E' : '#ECEDF1',
    }),
    [isDark],
  );
}
