import { describe, it, expect } from 'vitest';
import {
  rewardExplainer,
  progressLabel,
  remainingMessage,
  shouldShowVerificationPopup,
  rewardOutcomeMessage,
  type VerificationStatus,
} from '@/src/lib/verificationReward';

const base: VerificationStatus = {
  enrolled: true,
  featureEnabled: true,
  email: 'al***@example.com',
  phone: '+91****3210',
  hasEmail: true,
  hasPhone: true,
  emailVerified: false,
  phoneVerified: false,
  requireEmail: true,
  requirePhone: true,
  remaining: ['email', 'phone'],
  registrationReward: 10,
  completionReward: 90,
  totalReward: 100,
  earnedReward: 10,
  completed: false,
  completedAt: null,
  promptDue: true,
  nextPromptAt: 0,
  emailResendCooldownSec: 60,
  smsResendCooldownSec: 60,
};

describe('copy', () => {
  it('says exactly the required explainer with the default amounts (90 additional, not another 100)', () => {
    expect(rewardExplainer(base)).toBe(
      'Register karne par 10 Diamond milte hain. Email aur mobile number dono verify karne par additional 90 Diamond milenge. Total reward: 100 Diamond.',
    );
  });

  it('a new account (no signup bonus) is only told about the verification reward', () => {
    expect(rewardExplainer({ registrationReward: 0, completionReward: 90, totalReward: 90 })).toBe(
      'Email aur mobile number dono verify karne par 90 Diamond milenge.',
    );
    expect(progressLabel({ earnedReward: 0, totalReward: 90 })).toBe('0/90 Diamond');
  });

  it('shows progress and what is still missing for each state', () => {
    expect(progressLabel(base)).toBe('10/100 Diamond');
    expect(remainingMessage(base)).toMatch(/email and mobile/);
    expect(remainingMessage({ ...base, remaining: ['phone'] })).toMatch(/^Email verified\. Verify your mobile/);
    expect(remainingMessage({ ...base, remaining: ['email'] })).toMatch(/^Mobile verified\. Verify your email/);
    expect(progressLabel({ ...base, earnedReward: 100 })).toBe('100/100 Diamond');
    expect(remainingMessage({ ...base, completed: true, remaining: [] })).toBe('');
  });

  it('only claims success when the server credited coins', () => {
    expect(rewardOutcomeMessage({ credited: true, coins: 90, reason: 'credited' })).toBe('90 bonus coins added to your wallet!');
    expect(rewardOutcomeMessage({ credited: false, coins: 0, reason: 'phone_unverified' })).toBeNull();
    expect(rewardOutcomeMessage(undefined)).toBeNull();
  });
});

describe('popup visibility', () => {
  const show = (over: Partial<Parameters<typeof shouldShowVerificationPopup>[0]> = {}) =>
    shouldShowVerificationPopup({ status: base, signedIn: true, onHome: true, shownThisSession: false, ...over });

  it('shows when the server says a prompt is due, on home, once per session', () => {
    expect(show()).toBe(true);
    expect(show({ shownThisSession: true })).toBe(false);
    expect(show({ onHome: false })).toBe(false);
    expect(show({ signedIn: false })).toBe(false);
  });

  it('never shows when not due, completed, not enrolled, disabled or no bonus', () => {
    expect(show({ status: { ...base, promptDue: false } })).toBe(false);
    expect(show({ status: { ...base, completed: true, remaining: [] } })).toBe(false);
    expect(show({ status: { ...base, enrolled: false } })).toBe(false);
    expect(show({ status: { ...base, featureEnabled: false } })).toBe(false);
    expect(show({ status: { ...base, completionReward: 0 } })).toBe(false);
    expect(show({ status: null })).toBe(false);
  });
});
