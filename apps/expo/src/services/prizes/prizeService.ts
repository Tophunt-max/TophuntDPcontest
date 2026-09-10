/**
 * Physical prizes the signed-in user has won, and the delivery address they
 * submit to claim one.
 *
 * A contest can award coins or a product. Coins land in the wallet with no user
 * action at all; a product cannot be sent anywhere until the winner tells us where
 * to send it, which makes this the only place in the app where a user must act to
 * receive something they have already won.
 */
import { callApi, readApi } from '../api';

/**
 * Fulfilment lifecycle, exactly as the Worker writes it.
 *
 *   unclaimed  settlement created it; waiting on the WINNER for an address
 *   submitted  address given; waiting on an operator to check it
 *   approved   address accepted, being packed
 *   shipped    handed to a courier — `courier` + `trackingNumber` are set
 *   delivered  terminal
 *   cancelled  terminal; `adminNote` says why
 */
export type PrizeClaimStatus =
  | 'unclaimed'
  | 'submitted'
  | 'approved'
  | 'shipped'
  | 'delivered'
  | 'cancelled';

/** The address fields, named as `/api submitPrizeClaim` expects them. */
export interface DeliveryAddress {
  recipientName: string;
  phone: string;
  addressLine1: string;
  addressLine2?: string | null;
  landmark?: string | null;
  city: string;
  state: string;
  postalCode: string;
  country?: string | null;
  notes?: string | null;
}

/** One prize, as `GET /read/prizes` returns it. */
export interface PrizeClaim {
  id: string;
  matchId: string;
  contestId: string | null;
  status: PrizeClaimStatus;
  productTitle: string;
  productImageUrl: string | null;
  /** Declared retail value in rupees. Display only — never credited. */
  productValue: number;
  hasAddress: boolean;
  /**
   * Whether the address can still be changed. The server's own condition, so the
   * form is never offered for an edit the server would then refuse.
   */
  canEditAddress: boolean;
  delivery: DeliveryAddress | null;
  courier: string | null;
  trackingNumber: string | null;
  /** Only set when cancelled — the reason the operator gave. */
  adminNote: string | null;
  createdAt: number;
  submittedAt: number | null;
  shippedAt: number | null;
  deliveredAt: number | null;
}

export const prizeService = {
  /**
   * Every prize this user has won, newest first.
   *
   * Served `private, no-store` — it carries the user's own delivery address, so it
   * is deliberately not cached at either tier.
   */
  listMyPrizes: async (): Promise<PrizeClaim[]> => {
    const data = await readApi('/read/prizes');
    return Array.isArray(data) ? data : [];
  },

  /**
   * Submit or correct the delivery address for a prize.
   *
   * Keyed by `matchId`: the Worker derives the claim id (`prize_claim:<matchId>`)
   * itself, and the match id is what a notification's `targetId` carries.
   *
   * Not retried. The write is a conditional UPDATE and therefore idempotent, but it
   * is rate-limited to 10/hour FAIL-CLOSED, so a silent retry spends a second
   * attempt from a small budget the user may need in order to fix a typo.
   */
  submitClaim: async (matchId: string, delivery: DeliveryAddress) => {
    return (await callApi('submitPrizeClaim', { matchId, delivery })) as {
      success: true;
      status: 'submitted';
    };
  },
};

/** Prizes still waiting on the winner to give an address. */
export function needsAddress(claims: PrizeClaim[]): PrizeClaim[] {
  return claims.filter((claim) => claim.status === 'unclaimed');
}
