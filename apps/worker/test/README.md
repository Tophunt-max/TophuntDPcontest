# Worker tests

Money-critical unit/integration tests for the Cloudflare Worker API. They run
the **real handlers** (`src/routes/api.ts`) so the actual SQL, conditional
`UPDATE ... WHERE`, `meta.changes` guards, and payment logic are exercised.

## Run

```bash
cd apps/worker
npm install
npm test          # vitest run
npm run test:watch
```

Requires **Node 22+** (uses the built-in `node:sqlite`).

## How it works

Cloudflare's `workerd` runtime (and therefore `@cloudflare/vitest-pool-workers`)
cannot start in every CI/sandbox — it needs CPU-affinity syscalls that some
containers don't expose (`tcmalloc ... NumPossibleCPUsNoCache`). To stay
portable, the tests back the **drizzle D1 driver** with an in-memory
`node:sqlite` database via a tiny shim (`test/helpers/harness.ts`).

The drizzle-d1 driver only needs a small surface — `prepare/bind/all/run/raw`
plus `batch` — which the shim implements, so handlers behave exactly as they do
on real D1 (including `db.batch(...)` and affected-row checks). Firebase token
verification is mocked; KV is an in-memory map; migrations in `../migrations`
are applied to a fresh DB per test file.

## Coverage

- **createOrder** — server-side pricing from `coin_packages`, inactive-package
  rejection, fail-closed when the gateway is unconfigured.
- **topup** — verified-payment credit (server-authoritative coin amount),
  tampered-signature rejection, wrong-user rejection, no double-credit on replay.
- **claimDailyReward** — base + streak bonus, same-day double-claim rejection.
- **startMatch / joinMatch** — entry-fee deduction, insufficient-balance
  rejection (no deduction), self-join block, second-joiner rejection.
- **submitVote** — validation guards (missing fields, non-active match,
  participant self-vote, non-participant target).

## Not covered here

The full vote tally/de-duplication runs inside the `VoteCounter` Durable Object,
which needs the workerd runtime. Run those in an environment that supports
`@cloudflare/vitest-pool-workers` (most CI runners do), or exercise them via an
integration/e2e test against a deployed preview.
