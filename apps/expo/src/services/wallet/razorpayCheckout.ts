import { walletService } from './walletService';

export interface PurchasePrefill {
  email?: string;
  contact?: string;
  name?: string;
}

/**
 * Runs the full coin-purchase flow for a package:
 *   1. Server creates a price-authoritative Razorpay order.
 *   2. The native Razorpay checkout collects the payment.
 *   3. Server verifies the signature and credits the coins.
 *
 * REQUIREMENTS (see apps/expo/PRODUCTION_TODO.md):
 *   - `react-native-razorpay` must be installed and the app must run as a
 *     custom dev client or a production/EAS build. This will NOT work in Expo
 *     Go (Expo Go cannot load arbitrary native modules).
 *   - The server must have RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET configured.
 *
 * Returns the number of coins credited on success. Throws a user-friendly
 * Error otherwise (including a clear message when run in an unsupported build).
 */
export async function purchasePackage(
  pkg: { id: string; name?: string },
  prefill?: PurchasePrefill,
): Promise<{ coins: number }> {
  // 1) Server-priced order.
  const order = await walletService.createOrder(pkg.id);

  // 2) Native checkout. Loaded lazily so a missing/incompatible native module
  //    degrades to a clear message instead of crashing the screen.
  let RazorpayCheckout: any;
  try {
    RazorpayCheckout = (await import('react-native-razorpay')).default;
  } catch {
    throw new Error(
      'Payments are only available in the installed app (not a preview). Please update to the latest version.',
    );
  }
  if (!RazorpayCheckout || typeof RazorpayCheckout.open !== 'function') {
    throw new Error('Payment module is unavailable in this build.');
  }

  const options = {
    key: order.keyId,
    order_id: order.orderId,
    amount: order.amount,
    currency: order.currency || 'INR',
    name: 'Tophunt',
    description: order.name || `${order.coins} Dpcoins`,
    prefill: prefill || {},
    theme: { color: '#FF4D67' },
  };

  let data: any;
  try {
    data = await RazorpayCheckout.open(options);
  } catch (err: any) {
    // Razorpay rejects with { code, description } on cancel/failure.
    if (err?.code === 0 || /cancel/i.test(err?.description || '')) {
      throw new Error('Payment cancelled.');
    }
    throw new Error(err?.description || 'Payment failed. Please try again.');
  }

  // 3) Server verification + credit (coins are server-authoritative).
  await walletService.confirmTopup({
    paymentId: data.razorpay_payment_id,
    orderId: data.razorpay_order_id,
    signature: data.razorpay_signature,
  });

  return { coins: order.coins };
}
