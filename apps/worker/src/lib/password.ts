/**
 * Canonical, server-side password policy.
 *
 * Client-side validation (signup / reset screens) is a UX nicety and is trivially
 * bypassable by calling the API directly. The Worker is the only place that can
 * actually GUARANTEE the policy, so every code path that sets a password
 * (account creation + password reset) must run this check.
 *
 * Policy (kept in sync with the Expo signup Zod schema):
 *   - at least 8 characters
 *   - at least one lowercase letter
 *   - at least one uppercase letter
 *   - at least one digit
 *   - at least one special (non-alphanumeric) character
 */
import { httpsError } from "./http";

export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 128;

export function validatePasswordStrength(password: unknown): string {
  if (typeof password !== "string" || password.length === 0)
    throw httpsError("invalid-argument", "Password is required.");
  if (password.length < MIN_PASSWORD_LENGTH)
    throw httpsError("invalid-argument", `Password must be at least ${MIN_PASSWORD_LENGTH} characters long.`);
  if (password.length > MAX_PASSWORD_LENGTH)
    throw httpsError("invalid-argument", `Password must be at most ${MAX_PASSWORD_LENGTH} characters long.`);
  if (!/[a-z]/.test(password))
    throw httpsError("invalid-argument", "Password must contain at least one lowercase letter.");
  if (!/[A-Z]/.test(password))
    throw httpsError("invalid-argument", "Password must contain at least one uppercase letter.");
  if (!/\d/.test(password))
    throw httpsError("invalid-argument", "Password must contain at least one number.");
  if (!/[^a-zA-Z0-9]/.test(password))
    throw httpsError("invalid-argument", "Password must contain at least one special character.");
  return password;
}
