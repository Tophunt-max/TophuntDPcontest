import { callApi, readApi } from './api';
import type { RewardOutcome, VerificationStatus } from '../lib/verificationReward';

/** react-query key for the caller's verification status. Always uid-scoped. */
export const verificationStatusKey = (uid: string | undefined | null) => ['verification-status', uid ?? null] as const;

export const verificationRewardService = {
  /** The caller's own status (uid comes from the token server-side). */
  getStatus: (): Promise<VerificationStatus> => readApi('/read/me/verification'),

  /**
   * Re-read verification from Firebase's own record server-side (e.g. after the
   * user tapped the email link sent at signup), then attempt the bonus.
   */
  refresh: async (): Promise<{ reward: RewardOutcome; status: VerificationStatus }> =>
    callApi('refreshVerification', {}),

  /** Idempotent: the server credits at most once, and only if eligible. */
  claim: async (): Promise<{ reward: RewardOutcome; status: VerificationStatus }> =>
    callApi('claimVerificationReward', {}),

  /** Record a showing so the server can schedule the next reminder. Best-effort. */
  markPromptShown: async (): Promise<void> => {
    try {
      await callApi('markVerificationPromptShown', {});
    } catch {
      /* the next status fetch will simply still say "due"; harmless */
    }
  },
};
