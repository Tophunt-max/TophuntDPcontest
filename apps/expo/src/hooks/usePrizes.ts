import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../services/auth';
import {
  prizeService,
  type DeliveryAddress,
  type PrizeClaim,
} from '../services/prizes/prizeService';

/** Cache key for the signed-in user's prizes. Exported so screens can invalidate it. */
export const prizesQueryKey = (uid: string | undefined) => ['prizes', uid ?? 'anon'] as const;

/**
 * Every physical prize this user has won.
 *
 * `staleTime` is a parameter rather than a constant because the two callers have
 * genuinely different needs, and `/read/prizes` is `private, no-store` — every miss
 * is a real D1 read, not an edge hit.
 *
 *  - The prize SCREENS want 0: what they show ("does this still need an address?",
 *    "where is my parcel?") changes because of an action taken elsewhere — the
 *    user's own submit, or an operator shipping it — so a stale answer is the one
 *    thing a winner chasing a delivery will not accept.
 *  - The profile ENTRY CARD wants a long one. It mounts on every own-profile render
 *    for every user in the app, and almost all of them have never won a product, so
 *    at 0 it would spend an uncached query per mount to re-learn that.
 */
export const useMyPrizes = ({ staleTime = 0 }: { staleTime?: number } = {}) => {
  const { user } = useAuth();
  return useQuery({
    queryKey: prizesQueryKey(user?.uid),
    queryFn: prizeService.listMyPrizes,
    enabled: !!user?.uid,
    staleTime,
  });
};

/**
 * A single prize, addressed by MATCH id — what a notification's `targetId` carries.
 *
 * `pending` is NOT the same as `isLoading`. The query is disabled until auth
 * resolves, and a disabled query reports `isLoading: false` with no data — so a
 * notification tapped from the OS tray, which pushes this route directly, would
 * render "prize not found" for the instant before the user is known. Callers must
 * branch on `pending`.
 */
export const usePrize = (matchId: string | undefined) => {
  const { user } = useAuth();
  const query = useMyPrizes();
  const claim: PrizeClaim | undefined = matchId
    ? query.data?.find((c) => c.matchId === matchId || c.id === `prize_claim:${matchId}`)
    : undefined;
  return { ...query, claim, pending: query.isLoading || !user?.uid };
};

/**
 * Submit or correct a delivery address.
 *
 * Invalidates the list rather than patching it, because the server decides the
 * resulting status and the timestamps that go with it.
 */
export const useSubmitPrizeClaim = () => {
  const { user } = useAuth();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ matchId, delivery }: { matchId: string; delivery: DeliveryAddress }) =>
      prizeService.submitClaim(matchId, delivery),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: prizesQueryKey(user?.uid) });
    },
  });
};
