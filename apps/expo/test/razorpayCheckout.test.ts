import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Client half of the coin purchase. The server prices the order, verifies the
 * signature and credits coins; these tests pin what the CLIENT does with each
 * outcome, because each one decides what the buyer is told about their money.
 *
 * This file was skipped for a "Rollup: Expected 'from', got 'typeOf'" error. That
 * came from `react-native` itself (Flow `import typeof` in its source), which
 * razorpayCheckout.ts imports for `Platform`, not from react-native-razorpay.
 * Mocking `react-native` like the other service tests do is the fix.
 */

const platform = { OS: 'android' as string };
vi.mock('react-native', () => ({ Platform: platform }));

const createOrder = vi.fn(async (_pkgId: string) => ({
  orderId: 'order_1',
  amount: 19900,
  currency: 'INR',
  keyId: 'rzp_key',
  coins: 120,
  name: '120 Dpcoins',
}));
const confirmTopup = vi.fn(async (_proof: unknown): Promise<any> => ({ success: true }));
vi.mock('@/src/services/wallet/walletService', () => ({
  walletService: {
    createOrder: (id: string) => createOrder(id),
    confirmTopup: (proof: unknown) => confirmTopup(proof),
  },
}));

// Native Razorpay SDK (dynamically imported inside purchasePackage).
const open = vi.fn(async (_opts: unknown): Promise<any> => ({
  razorpay_payment_id: 'pay_1',
  razorpay_order_id: 'order_1',
  razorpay_signature: 'sig_1',
}));
vi.mock('react-native-razorpay', () => ({ default: { open: (o: unknown) => open(o) } }));

const { purchasePackage } = await import('@/src/services/wallet/razorpayCheckout');

beforeEach(() => {
  platform.OS = 'android';
  createOrder.mockClear();
  confirmTopup.mockClear();
  open.mockClear();
});

describe('purchasePackage (native)', () => {
  it('runs createOrder -> checkout -> confirmTopup and returns credited coins', async () => {
    const result = await purchasePackage({ id: 'pkg1', name: '120 Dpcoins' });

    expect(createOrder).toHaveBeenCalledWith('pkg1');
    // Checkout gets the SERVER order id, key and amount, never a client price.
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({ order_id: 'order_1', key: 'rzp_key', amount: 19900 }),
    );
    // Proof handed back for server-side signature verification.
    expect(confirmTopup).toHaveBeenCalledWith({ paymentId: 'pay_1', orderId: 'order_1', signature: 'sig_1' });
    expect(result).toEqual({ coins: 120 });
  });

  it('maps a user cancellation to a friendly error and skips confirmTopup', async () => {
    open.mockRejectedValueOnce({ code: 0, description: 'Payment cancelled by user' });
    await expect(purchasePackage({ id: 'pkg1' })).rejects.toThrow('Payment cancelled.');
    expect(confirmTopup).not.toHaveBeenCalled();
  });

  it('surfaces a gateway failure description and skips confirmTopup', async () => {
    open.mockRejectedValueOnce({ code: 2, description: 'Card declined' });
    await expect(purchasePackage({ id: 'pkg1' })).rejects.toThrow('Card declined');
    expect(confirmTopup).not.toHaveBeenCalled();
  });

  it('reports pending with 0 coins when the server has not confirmed capture', async () => {
    confirmTopup.mockResolvedValueOnce({ pending: true });
    await expect(purchasePackage({ id: 'pkg1' })).resolves.toEqual({ coins: 0, pending: true });
  });

  it('treats "already processed" (webhook credited first) as success', async () => {
    confirmTopup.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: 'functions/already-exists' }));
    await expect(purchasePackage({ id: 'pkg1' })).resolves.toEqual({ coins: 120 });
  });

  it('propagates any other confirm failure instead of claiming coins', async () => {
    confirmTopup.mockRejectedValueOnce(Object.assign(new Error('Signature mismatch'), { code: 'invalid-argument' }));
    await expect(purchasePackage({ id: 'pkg1' })).rejects.toThrow('Signature mismatch');
  });

  it('does not open checkout when order creation fails', async () => {
    createOrder.mockRejectedValueOnce(new Error('Package unavailable'));
    await expect(purchasePackage({ id: 'gone' })).rejects.toThrow('Package unavailable');
    expect(open).not.toHaveBeenCalled();
    expect(confirmTopup).not.toHaveBeenCalled();
  });
});

describe('purchasePackage (web)', () => {
  it('fails closed without a DOM instead of reaching the native module', async () => {
    platform.OS = 'web';
    await expect(purchasePackage({ id: 'pkg1' })).rejects.toThrow(/unavailable in this environment/);
    expect(open).not.toHaveBeenCalled();
    expect(confirmTopup).not.toHaveBeenCalled();
  });
});
