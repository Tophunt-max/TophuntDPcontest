/**
 * Client password policy, which must agree with apps/worker/src/lib/password.ts.
 *
 * Two reasons this is tested rather than trusted:
 *
 *  - the reset screen used to carry its own inline copy of the rules WITHOUT the
 *    128-character maximum the Worker enforces, so a longer password passed every
 *    check the user could see and was then rejected by the API.
 *  - the Firebase-hosted reset path (`confirmPasswordReset`) only enforces
 *    Firebase's own 6-character weak-password rule. Without a check on our side, a
 *    reset could set a password that our own signup would have refused — the
 *    account would then hold a password weaker than the policy claims to require.
 */
import { describe, it, expect } from 'vitest';
import {
  validatePassword,
  isPasswordValid,
  passwordRequirements,
  MIN_PASSWORD_LENGTH,
  MAX_PASSWORD_LENGTH,
} from '@/src/lib/passwordPolicy';

const GOOD = 'Str0ng!Passw0rd';

describe('validatePassword', () => {
  it('accepts a password meeting every rule', () => {
    expect(validatePassword(GOOD)).toBeNull();
    expect(isPasswordValid(GOOD)).toBe(true);
  });

  it('names the specific missing requirement', () => {
    expect(validatePassword('short1!A')).toBeNull(); // exactly 8, all classes
    expect(validatePassword('NOLOWER1!')).toMatch(/lowercase/i);
    expect(validatePassword('noupper1!')).toMatch(/uppercase/i);
    expect(validatePassword('NoDigits!')).toMatch(/number/i);
    expect(validatePassword('NoSpecial1')).toMatch(/special/i);
  });

  it('enforces the minimum at the exact boundary', () => {
    const seven = 'Ab1!def'; // 7 chars, all classes present
    expect(seven).toHaveLength(MIN_PASSWORD_LENGTH - 1);
    expect(validatePassword(seven)).toMatch(/at least 8/i);
    expect(validatePassword(`${seven}g`)).toBeNull();
  });

  it('enforces the maximum the Worker also enforces', () => {
    // This is the rule the old inline schema was missing entirely.
    const atMax = `Ab1!${'x'.repeat(MAX_PASSWORD_LENGTH - 4)}`;
    expect(atMax).toHaveLength(MAX_PASSWORD_LENGTH);
    expect(validatePassword(atMax)).toBeNull();
    expect(validatePassword(`${atMax}y`)).toMatch(/at most 128/i);
  });

  it('rejects empty and non-string input without throwing', () => {
    expect(validatePassword('')).toMatch(/required/i);
    expect(validatePassword(undefined)).toMatch(/required/i);
    expect(validatePassword(null)).toMatch(/required/i);
    expect(validatePassword(12345678)).toMatch(/required/i);
  });

  it('counts a space as a special character, as the Worker does', () => {
    // /[^a-zA-Z0-9]/ matches a space in both implementations; asserting it here
    // stops the two from being "tidied" apart later.
    expect(validatePassword('Abcdefg1 ')).toBeNull();
  });
});

describe('passwordRequirements', () => {
  it('goes fully green exactly when the validator accepts', () => {
    const allMet = (pw: string) => passwordRequirements(pw).every((r) => r.met);
    // A checklist that disagrees with the validator is worse than none: the user
    // sees five ticks and a rejection.
    for (const pw of ['', 'abc', 'Abcdefg1', 'Abcdefg1!', GOOD, `Ab1!${'x'.repeat(MAX_PASSWORD_LENGTH)}`]) {
      expect(allMet(pw)).toBe(isPasswordValid(pw));
    }
  });

  it('marks the length rule unmet when the password is too long', () => {
    const tooLong = `Ab1!${'x'.repeat(MAX_PASSWORD_LENGTH)}`;
    const lengthRule = passwordRequirements(tooLong)[0];
    expect(lengthRule.met).toBe(false);
  });

  it('reports progress per rule as the user types', () => {
    const labels = passwordRequirements('a').map((r) => r.met);
    expect(labels).toEqual([false, true, false, false, false]);
  });
});
