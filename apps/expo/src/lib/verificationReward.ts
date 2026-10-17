/**
 * Registration verification reward — pure client logic (no React / RN imports).
 *
 * The SERVER decides everything that matters: amounts, eligibility, whether a
 * prompt is due (reminders are scheduled server-side so they survive reinstalls
 * and are shared across devices), and whether the bonus was credited. This module
 * only turns the server's status into copy and a show/hide decision.
 */

export interface VerificationStatus {
  enrolled: boolean;
  featureEnabled: boolean;
  email: string | null; // masked
  phone: string | null; // masked
  hasEmail: boolean;
  hasPhone: boolean;
  emailVerified: boolean;
  phoneVerified: boolean;
  requireEmail: boolean;
  requirePhone: boolean;
  remaining: ('email' | 'phone')[];
  registrationReward: number;
  completionReward: number;
  totalReward: number;
  earnedReward: number;
  completed: boolean;
  completedAt: number | null;
  promptDue: boolean;
  nextPromptAt: number | null;
  emailResendCooldownSec: number;
  smsResendCooldownSec: number;
}

export interface RewardOutcome {
  credited: boolean;
  coins: number;
  reason: string;
}

/** The explainer line, with the server's amounts. Defaults read 10 / 90 / 100. */
export function rewardExplainer(s: Pick<VerificationStatus, 'registrationReward' | 'completionReward' | 'totalReward'>): string {
  return (
    `Register karne par ${s.registrationReward} coins milte hain. ` +
    `Email aur mobile number dono verify karne par additional ${s.completionReward} coins milenge. ` +
    `Total reward: ${s.totalReward} coins.`
  );
}

/** "10/100 coins" — earned so far out of the total on offer. */
export function progressLabel(s: Pick<VerificationStatus, 'earnedReward' | 'totalReward'>): string {
  return `${s.earnedReward}/${s.totalReward} coins`;
}

/** What is still needed, in plain words. Empty when nothing is. */
export function remainingMessage(s: Pick<VerificationStatus, 'remaining' | 'completed' | 'completionReward'>): string {
  if (s.completed) return '';
  const need = s.remaining;
  if (need.length === 2) return `Verify your email and mobile number to unlock ${s.completionReward} more coins.`;
  if (need[0] === 'phone') return `Email verified. Verify your mobile number too to unlock ${s.completionReward} more coins.`;
  if (need[0] === 'email') return `Mobile verified. Verify your email too to unlock ${s.completionReward} more coins.`;
  // Both verified but not yet completed: the credit is pending on the server.
  return 'Both verified — confirming your reward…';
}

/** Has the reward programme anything to show this user at all? */
export function hasRewardOffer(s: VerificationStatus | null | undefined): boolean {
  return !!s && s.enrolled && s.featureEnabled && s.completionReward > 0;
}

/**
 * Should the popup open now? Server says it is due; we are on the home screen
 * (never mid-signup or over another flow); and we have not already shown it in
 * this app session (protects against re-renders and repeated focus events).
 */
export function shouldShowVerificationPopup(input: {
  status: VerificationStatus | null | undefined;
  signedIn: boolean;
  onHome: boolean;
  shownThisSession: boolean;
}): boolean {
  const { status, signedIn, onHome, shownThisSession } = input;
  if (!signedIn || !onHome || shownThisSession) return false;
  if (!hasRewardOffer(status)) return false;
  if (status!.completed || status!.remaining.length === 0) return false;
  return status!.promptDue === true;
}

/** User-facing message for a reward outcome returned by a verify/claim call. */
export function rewardOutcomeMessage(outcome: RewardOutcome | null | undefined): string | null {
  if (!outcome) return null;
  if (outcome.credited && outcome.coins > 0) return `${outcome.coins} bonus coins added to your wallet!`;
  if (outcome.reason === 'identifier_already_rewarded') {
    return 'This email or mobile number has already earned the verification bonus on another account.';
  }
  return null;
}
