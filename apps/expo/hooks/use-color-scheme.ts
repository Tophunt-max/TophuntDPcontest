/**
 * The app's colour scheme.
 *
 * This is a drop-in replacement for react-native's `useColorScheme`, but it
 * honours the user's in-app Dark Mode preference (see
 * `src/lib/themePreference.ts`). Screens must import from here rather than from
 * `react-native`, otherwise the Settings toggle has no effect on them — which is
 * exactly the bug this replaced.
 */
export { useResolvedColorScheme as useColorScheme } from '@/src/lib/themePreference';
