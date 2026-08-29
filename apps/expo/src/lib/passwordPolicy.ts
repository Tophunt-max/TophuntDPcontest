/**
 * Client mirror of the canonical password policy in
 * apps/worker/src/lib/password.ts.
 *
 * The Worker is the only place that can GUARANTEE the policy, so this is a UX
 * layer — but it has to agree with the server, and it did not. The reset screen
 * carried its own inline Zod schema with the four character-class rules and the
 * 8-character minimum, and no maximum. The Worker enforces a 128-character
 * maximum too, so a longer password passed every check the user could see and was
 * then rejected by the API. Having one module means the next rule change cannot
 * drift in only one of the two places.
 *
 * The Firebase-hosted path has the same requirement: `confirmPasswordReset`
 * enforces only Firebase's own weak-password rule (6 characters), which is looser
 * than ours, so without checking here a reset could produce a password that our
 * own signup would have refused.
 */

export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 128;

/**
 * The first unmet requirement, as a sentence to show the user, or null when the
 * password is acceptable.
 *
 * Returns ONE message rather than a list because these render in a single inline
 * error slot; the order matches the Worker's so the two never contradict each
 * other for the same input.
 */
export function validatePassword(password: unknown): string | null {
  if (typeof password !== 'string' || password.length === 0) return 'Password is required.';
  if (password.length < MIN_PASSWORD_LENGTH)
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters long.`;
  if (password.length > MAX_PASSWORD_LENGTH)
    return `Password must be at most ${MAX_PASSWORD_LENGTH} characters long.`;
  if (!/[a-z]/.test(password)) return 'Password must contain at least one lowercase letter.';
  if (!/[A-Z]/.test(password)) return 'Password must contain at least one uppercase letter.';
  if (!/\d/.test(password)) return 'Password must contain at least one number.';
  if (!/[^a-zA-Z0-9]/.test(password)) return 'Password must contain at least one special character.';
  return null;
}

/** True when the password satisfies every rule. */
export const isPasswordValid = (password: unknown): boolean => validatePassword(password) === null;

/**
 * The requirement checklist, for screens that show live progress as the user
 * types. Deliberately derived from the same predicates as `validatePassword`, so
 * a checklist can never show all-green on a password the validator rejects.
 */
export function passwordRequirements(password: string): { label: string; met: boolean }[] {
  const pw = password ?? '';
  return [
    { label: `At least ${MIN_PASSWORD_LENGTH} characters`, met: pw.length >= MIN_PASSWORD_LENGTH && pw.length <= MAX_PASSWORD_LENGTH },
    { label: 'A lowercase letter', met: /[a-z]/.test(pw) },
    { label: 'An uppercase letter', met: /[A-Z]/.test(pw) },
    { label: 'A number', met: /\d/.test(pw) },
    { label: 'A special character', met: /[^a-zA-Z0-9]/.test(pw) },
  ];
}
