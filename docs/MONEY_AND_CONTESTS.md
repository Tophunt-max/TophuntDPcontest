# Coins, payments, contests and rewards

The rules every change to money or contest code must keep, and what each path
does after Phase G. Code: `apps/worker/src` (Worker), `apps/admin-panel` (panel).

## Invariants

1. **Server authority.** Balances, prices, prizes, votes, winners and payout
   decisions are computed on the server from its own rows. No amount, price or
   balance is read from a request body.
2. **One batch per balance change.** Every write to `users.dpcoin` sits in one D1
   batch with its `coin_transactions` row, gated on the same claim (a
   compare-and-swap on status, an idempotency nonce, or a deterministic ledger
   id). `users.dpcoin == SUM(coin_transactions.amount)` for every user.
3. **Whole coins only** (`assertCoinAmount`, at most 10,000,000 per operation).
4. **Debits never go below zero**, except a refund or chargeback clawback, which
   may, and records `clawback_shortfall`.
5. **Nothing money-related is queued offline.** The app's outbox carries only
   likes, bookmarks and follows (`apps/expo/src/sync/outbox.ts`).

## Contests and battles

| Step | Guard |
|---|---|
| Create (`startMatch`) | Contest live and inside its window, fee from the contest row, debit + match + ledger in one batch |
| Join (`joinMatch`) | Claim UPDATE: still waiting, no player B, not your own, before `expires_at`, enough coins. Debit and ledger gated on the claim |
| Vote (`submitVote`) | Signed in, not a participant, target is a participant, not blocked, before the deadline. The `VoteCounter` Durable Object is the source of truth; one vote per account and per device id |
| Settle (cron) | `finalizeVotes` closes the DO; tie → refund both; below `min_votes_required` → refund; same device on both sides → void; otherwise the winner gets `min(prize snapshot, pot)` |
| Admin declare-winner | Without `winnerUid`, the same tie and minimum-votes rules (refused with a message, before voting is closed). With `winnerUid`, the admin decides |
| Admin cancel | Refunds both entry fees |

Every settlement is a compare-and-swap on `status` + `settlement_id`, with
deterministic ledger ids (`contest_refund:<match>:<uid>`, `contest_win:<match>`),
so the cron, the read-path kick and an admin cannot pay twice.

## Purchases (Razorpay)

- The price comes from the active `coin_packages` row; the client sends only a
  package id.
- Checkout and webhook signatures are HMAC-SHA256, compared in constant time; the
  webhook is verified over the raw body and fails closed without a secret.
- Credit is exactly-once: order status CAS (`created`/`expired` → `paid`), the
  `payments` row (PK = payment id) and the `purchase:<paymentId>` ledger id. The
  captured amount and currency must match the order. A mismatch credits nothing
  and now raises an admin notification.
- **Refunds and chargebacks** claw coins back proportionally and cumulatively,
  once per refund id. A refund that arrives BEFORE the credit finds the order by
  its order id and closes it (`refunded`), so a later capture or the reconcile
  sweep cannot credit it. If a capture credits the order during the clawback,
  the clawback re-reads and reverses it.
- `reconcilePaymentOrders` (every 10 minutes) credits captured payments whose
  callback and webhook were both lost.

## Withdrawals

- Requested coins are escrowed at once (`withdrawal_hold:<id>`), within the
  admin's min/max/daily limits and the server-computed fee.
- Admin transitions: pending → approved/rejected, approved → paid/rejected, each a
  compare-and-swap. Paid needs a bank reference. Rejected refunds exactly once
  (`withdrawal_refund:<id>`).
- **Approve and paid are refused** while the user's balance is negative or they
  have a `disputed` payment. Reject stays allowed.
- The audit row is written before the user notification.

## Rewards

| Grant | Guard |
|---|---|
| Daily login | One per UTC day (CAS on `last_daily_claim` + per-day ledger id; the credit requires this request's ledger row). Bonus = base + min(streak, 30) × streak bonus |
| Daily tasks | Per-day, per-task ledger id |
| Rewarded ads | **Fail-closed.** No AdMob SSV endpoint exists; the credit refuses unless ads are enabled, `ads.trustClient` is set and `ALLOW_UNVERIFIED_AD_REWARDS=true`. None is set. The app shows "coming soon" and never calls it |
| Referral | Self-referral refused; paid once per invitee (claim keys) when the qualifying action happens (default: first contest); per-referrer caps |
| Verification reward | One per account and per verified email/phone, amount snapshotted, one batch |
| Signup bonus | None (refused in settings) |
| Hall of Fame | Monthly, nonce-claimed |

## Admin wallet adjustments

`POST /admin/users/:id/wallet` (full admins only) needs `amount`, `type`,
`reason` (3-200 characters) and `requestId` (or an `Idempotency-Key` header). The
same request id is applied once. The ledger description names the admin and
the reason; the audit row also records the balance before and after.

## Monitoring

`computeMoneyHealth` (Admin → System Health) checks ledger drift, negative
balances, paid-but-uncredited orders, approved-but-uncredited deposits, clawback
shortfalls and escrowed withdrawals missing their hold or refund row. It now
also runs every 6 hours (`moneyHealthCheck` cron) and writes one admin
notification per day while anything fails.

## Known gaps and decisions for the owner

- **Withdrawing purchased coins.** Bought, bonus and reward coins are all
  withdrawable at once. A buyer can request a payout and then charge back the
  card; the payout is refused only if the chargeback lands first. Options: a
  holding period on purchased coins, a separate withdrawable balance, or KYC.
  Not decided, so not built.
- **Device ids are client-supplied.** The same-device checks (self-match, one
  vote per device, referral farming) stop casual abuse only; there is no device
  attestation.
- **Referral caps** are checked before the credit, so invitees qualifying at the
  same instant can exceed a referrer's cap. There is no referral clawback after a
  ban, and the invitee is paid even when the referrer is capped.
- **No KYC** anywhere.
- **XP** from entering a battle is kept when the battle is refunded.
- **Votes from accounts banned later** still count; eligibility is checked at
  vote time.
- **House margin** (pot − prize) has no ledger row.
- **Payout reference uniqueness** is a read-then-write; a unique index needs a
  check for existing duplicates in production first.
- The waiting-match refund sweep has no cursor; a match whose refund keeps
  failing is re-read every tick.
