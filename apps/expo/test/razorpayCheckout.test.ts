import { describe, it, expect, vi, beforeEach } from 'vitest';

const createOrder = vi.fn(async () => ({
  orderId: 'order_1',
  amount: 19900,
  currency: 'INR',
  keyId: 'rzp_key',
  coins: 120,
  name: '120 Dpcoins',
}));
const confirmTopup = vi.fn(async () => ({ success: true }));
vi.mock('@/src/services/wallet/walletService', () => ({
  walletService: { createOrder: (...a: any[]) => (createOrder as any)(...a), confirmTopup: (...a: any[]) => (confirmTopup as any)(...a) },
}));

// Native Razorpay SDK mock (dynamically imported inside purchasePackage).
const open = vi.fn(async () => ({
  razorpay_payment_id: 'pay_1',
  razorpay_order_id: 'order_1',
  razorpay_signature: 'sig_1',
}));
vi.mock('react-native-razorpay', () => ({ default: { open: (...a: any[]) => (open as any)(...a) } }));

beforeEach(() => {
  createOrder.mockClear();
  confirmTopup.mockClear();
  open.mockClear();
});

describe('purchasePackage', () => {
  it('runs createOrder -> checkout -> confirmTopup and returns credited coins', async () => {
    const { purchasePackage } = await import('@/src/services/wallet/razorpayCheckout');
    const result = await purchasePackage({ id: 'pkg1', name: '120 Dpcoins' });

    expect(createOrder).toHaveBeenCalledWith('pkg1');
    // Checkout gets the server order id + key.
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ order_id: 'order_1', key: 'rzp_key', amount: 19900 }));
    // Proof handed back for server verification.
    expect(confirmTopup).toHaveBeenCalledWith({ paymentId: 'pay_1', orderId: 'order_1', signature: 'sig_1' });
    expect(result).toEqual({ coins: 120 });
  });

  it('maps a user cancellation to a friendly error and skips confirmTopup', async () => {
    open.mockRejectedValueOnce({ code: 0, description: 'Payment cancelled by user' });
    const { purchasePackage } = await import('@/src/services/wallet/razorpayCheckout');
    await expect(purchasePackage({ id: 'pkg1' })).rejects.toThrow(/cancel/i);
    expect(confirmTopup).not.toHaveBeenCalled();
  });

  it('surfaces a gateway failure description', async () => {
    open.mockRejectedValueOnce({ code: 2, description: 'Card declined' });
    const { purchasePackage } = await import('@/src/services/wallet/razorpayCheckout');
    await expect(purchasePackage({ id: 'pkg1' })).rejects.toThrow('Card declined');
    expect(confirmTopup).not.toHaveBeenCalled();
  });
});
