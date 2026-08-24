import { useEffect, useState } from 'react';
import { useResolvedColorScheme } from '@/src/lib/themePreference';

/**
 * Web variant.
 *
 * Static rendering has no access to the client's colour scheme, so the first
 * paint must be deterministic ('light') and the real value is applied after
 * hydration. Beyond that it resolves identically to native, including the in-app
 * Dark Mode override.
 */
export function useColorScheme() {
  const [hasHydrated, setHasHydrated] = useState(false);

  useEffect(() => {
    setHasHydrated(true);
  }, []);

  const colorScheme = useResolvedColorScheme();

  if (hasHydrated) {
    return colorScheme;
  }

  return 'light';
}
