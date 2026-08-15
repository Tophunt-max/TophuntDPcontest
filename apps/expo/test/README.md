# Client tests (service / logic layer)

Unit tests for the app's pure service & utility layer — the code where money and
integrity logic lives. They run in plain Node via Vitest, with native modules
mocked, so **no React Native renderer or `jest-expo` setup is required** and they
stay fast and portable.

## Run

```bash
cd apps/expo
npm install
npm test          # vitest run
npm run test:watch
```

## Coverage

- **walletService** — `createOrder` sends only the packageId (server prices it),
  `confirmTopup` forwards the Razorpay proof, `claimDailyBonus` maps to the right
  action.
- **razorpayCheckout.purchasePackage** — full orchestration
  (createOrder → native checkout → confirmTopup), user-cancellation and gateway
  failure handling (no credit attempted on failure).
- **getDeviceId** — generates + persists a stable per-install id, reuses the
  stored value, caches within a session, and falls back gracefully when storage
  throws.
- **contestService.voteOnMatch** — attaches the stable device id (and respects an
  explicit one) for server-side vote de-duplication.

## Not covered here

React component/screen rendering (buttons, navigation, hooks that touch the RN
renderer) is out of scope for this suite. Those need the `jest-expo` preset +
`@testing-library/react-native`; add that as a separate harness when component
coverage is needed. This suite deliberately targets framework-agnostic logic so
it runs anywhere with zero native setup.
