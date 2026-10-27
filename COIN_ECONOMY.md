# Coin Economy

Every coin setting and report lives in the admin panel under **Coin Economy**
(`apps/admin-panel/src/pages/CoinEconomy.tsx`). Older pages (App Control, App
Settings, Referrals, Deposits, Rewards) link there, so each setting has one editor.

## Concepts

| Term | Meaning | Where |
|---|---|---|
| Locked coins | `users.locked_coins`. Play-only: spent first on entry fees, never withdrawable. Withdrawable = `dpcoin − locked_coins`. | `lib/money.ts`, `lib/rewardLocking.ts` |
| Ledger invariant | `locked_coins = SUM(coin_transactions.locked_delta)` per user, and `dpcoin = SUM(amount)`. Checked in Health. | `lib/coinEconomy.ts` |
| Promo budget | One per offer, with a hard coin limit, optional time window and per-user limit. Coins are reserved (`promo_reservations`), then spent. The platform side is written to `platform_ledger`. | `lib/promoBudget.ts` |
| Budget kinds | `package_bonus` (locked bonus on a coin package), `contest_prize` (coin prize above the pot), `product_prize` (admin-only coin cost of a physical prize, above the pot), `free_rewards` (cap on daily login, rewarded ads, daily tasks). | |
| Approval password | Separate from the login password. Required to create/edit a budget or link one to a package, contest or free rewards. 5 wrong tries = 15 min lock. Forgotten: superadmin resets it with an email code. | `lib/approvalPassword.ts` |

## What happens when a budget runs out

| Kind | Effect |
|---|---|
| package_bonus | Package sells without the promo bonus. |
| contest_prize | New matches pay the pot prize instead of the promo prize. |
| product_prize | New matches are refused (`prize_budget_exhausted`); the app shows "Prize khatam"; admin gets a notification. Raise the total to reopen. |
| free_rewards | Daily login, ads and tasks pay nothing (`free_rewards_exhausted`) until the total is raised. |

## Abuse checks (advisory, never block)

- **Withdrawal risk** (`lib/withdrawalRisk.ts`): flags `new_account`, `shared_device`, `mostly_free_coins`, `frequent`, `never_played`. High = shared device or 2+ flags. Shown in Withdrawals as a badge.
- **Referral holds** (`lib/referralProgram.ts`): `same_ip_burst`, `ip_shared`, `referrer_velocity`. A held referral goes to review instead of paying out.

## Alerts and reports (`lib/coinAlerts.ts`)

- Every 6 hours: budget ≥ 80% used, coin liability > net cash, a user with more free coins in 24h than `coinAlerts.dailyFreeCoinsPerUser` (default 300). Admin notification + email to `adminAlertEmail`, deduplicated.
- Report email: daily (08:30 IST) and weekly (Monday), switches in `coinReport`. Earn tab has "send now" and "check alerts now" buttons.

## Go-live checklist

1. Coin Economy → Budgets: set the approval password.
2. App Settings: set **Admin alert email**. Coin Economy → Earn → "Aaj ki report abhi bhejo" and confirm the email arrives.
3. Create a small test budget (e.g. 100 coins, `package_bonus`), link it to a hidden test package, buy it with a test account. Check the bonus arrives locked and the budget bar moves.
4. Create a `free_rewards` budget and link it in Earn → Free rewards budget. Claim the daily reward with a test account and check the budget is charged.
5. For a product contest: set the prize coin value, link a `product_prize` budget, play one match, and check Contests P&L.
6. Health tab: every row shows OK and every reconciliation check is green.
7. Withdrawals: request a payout from a new test account and check the Risk column shows flags.
