import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * "Last time you used Google" — remembered on this device only, so the login
 * screen can point a returning user at the button they actually use.
 */
export type LastAuthMethod = 'google' | 'facebook' | 'apple' | 'phone' | 'password';
const KEY = 'auth:lastMethod:v1';
const VALID: LastAuthMethod[] = ['google', 'facebook', 'apple', 'phone', 'password'];

export async function rememberAuthMethod(method: LastAuthMethod): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY, method);
  } catch {
    // Cosmetic; never block a sign-in.
  }
}

export async function lastAuthMethod(): Promise<LastAuthMethod | null> {
  try {
    const v = await AsyncStorage.getItem(KEY);
    return v && (VALID as string[]).includes(v) ? (v as LastAuthMethod) : null;
  } catch {
    return null;
  }
}
