import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * What the buyer is told after paying.
 *
 * The payment webhook usually reaches the server before the app's callback and
 * credits the order first; the callback then gets `already-exists`, which the
 * store screen used to show as an ERROR toast ("Payment already processed.")
 * right after a successful purchase. And when the gateway has not confirmed the
 * capture yet, the server now answers `{ pending: true }` instead of crediting —
 * which must not be shown as "N coins added".
 *
 * Runs the web checkout path with a stand-in `window.Razorpay`, so the native
 * `react-native-razorpay` module (which Vitest cannot transpile) is never loaded.
 */
vi.mock('react-native', () => ({ Platform: { OS: 'web' } }));

const confirmTopup = vi.fn();
vi.mock('../src/services/wallet/walletService', () => ({
  walletService: {
    createOrder: vi.fn(async () => ({ orderId: 'order_1', amount: 19900, currency: 'INR', keyId: 'rzp_k', coins: 120, name: '120' })),
    confirmTopup: (...args: any[]) => confirmTopup(...args),
  },
}));

import { purchasePackage } from '../src/services/wallet/razorpayCheckout';

class FakeRazorpay {
  constructor(private opts: any) {}
  on() {}
  open() {
    this.opts.handler({ razorpay_payment_id: 'pay_1', razorpay_order_id: 'order_1', razorpay_signature: 'sig' });
  }
}

beforeEach(() => {
  (globalThis as any).window = { Razorpay: FakeRazorpay };
  (globalThis as any).document = {};
  confirmTopup.mockReset();
});
afterEach(() => {
  delete (globalThis as any).window;
  delete (globalThis as any).document;
});

describe('purchasePackage outcome', () => {
  it('reports the credited coins on a normal success', async () => {
    confirmTopup.mockResolvedValue({ success: true, coins: 120 });
    await expect(purchasePackage({ id: 'p' })).resolves.toEqual({ coins: 120 });
    expect(confirmTopup).toHaveBeenCalledWith({ paymentId: 'pay_1', orderId: 'order_1', signature: 'sig' });
  });

  it('treats "already processed" (webhook credited first) as success, not an error', async () => {
    confirmTopup.mockRejectedValue(Object.assign(new Error('Payment already processed.'), { code: 'functions/already-exists' }));
    await expect(purchasePackage({ id: 'p' })).resolves.toEqual({ coins: 120 });
  });

  it('surfaces a pending capture as pending with no coins claimed', async () => {
    confirmTopup.mockResolvedValue({ success: true, pending: true, coins: 0 });
    await expect(purchasePackage({ id: 'p' })).resolves.toEqual({ coins: 0, pending: true });
  });

  it('still fails on a real verification error', async () => {
    confirmTopup.mockRejectedValue(Object.assign(new Error('Payment verification failed.'), { code: 'functions/permission-denied' }));
    await expect(purchasePackage({ id: 'p' })).rejects.toThrow('Payment verification failed.');
  });
});
