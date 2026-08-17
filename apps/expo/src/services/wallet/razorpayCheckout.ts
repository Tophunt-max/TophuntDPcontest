import { Platform } from 'react-native';
import { walletService, CreatedOrder } from './walletService';

export interface PurchasePrefill {
  email?: string;
  contact?: string;
  name?: string;
}

/** Proof handed back to the server for signature verification + crediting. */
interface CheckoutProof {
  paymentId: string;
  orderId: string;
  signature: string;
}

const RAZORPAY_WEB_SRC = 'https://checkout.razorpay.com/v1/checkout.js';
let webScriptPromise: Promise<void> | null = null;

/**
 * Lazily inject Razorpay's web checkout script exactly once. Resolves when
 * `window.Razorpay` is available. On the web build there is no native module,
 * so this script is the ONLY way to open the gateway.
 */
function loadRazorpayWebScript(): Promise<void> {
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    return Promise.reject(new Error('Payments are unavailable in this environment.'));
  }
  if ((window as any).Razorpay) return Promise.resolve();
  if (webScriptPromise) return webScriptPromise;

  webScriptPromise = new Promise<void>((resolve, reject) => {
    const fail = () => {
      webScriptPromise = null; // allow a retry on the next attempt
      reject(new Error('Could not load the payment gateway. Please check your connection and try again.'));
    };
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${RAZORPAY_WEB_SRC}"]`);
    if (existing) {
      if ((window as any).Razorpay) return resolve();
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', fail);
      return;
    }
    const script = document.createElement('script');
    script.src = RAZORPAY_WEB_SRC;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = fail;
    document.body.appendChild(script);
  });
  return webScriptPromise;
}

/** Web checkout via Razorpay's checkout.js + window.Razorpay(...). */
async function openWebCheckout(order: CreatedOrder, prefill?: PurchasePrefill): Promise<CheckoutProof> {
  await loadRazorpayWebScript();
  const Razorpay = (window as any).Razorpay;
  if (typeof Razorpay !== 'function') {
    throw new Error('Payment gateway failed to initialise. Please refresh and try again.');
  }

  return new Promise<CheckoutProof>((resolve, reject) => {
    let settled = false;
    const rzp = new Razorpay({
      key: order.keyId,
      order_id: order.orderId,
      amount: order.amount, // paise; informational — order_id is authoritative
      currency: order.currency || 'INR',
      name: 'Tophunt',
      description: order.name || `${order.coins} Dpcoins`,
      prefill: {
        name: prefill?.name || undefined,
        email: prefill?.email || undefined,
        contact: prefill?.contact || undefined,
      },
      theme: { color: '#FF4D67' },
      // Fired on a successful, signed payment.
      handler: (resp: any) => {
        settled = true;
        resolve({
          paymentId: resp.razorpay_payment_id,
          orderId: resp.razorpay_order_id,
          signature: resp.razorpay_signature,
        });
      },
      modal: {
        // Closing the sheet without paying is a normal cancel, not an error.
        ondismiss: () => {
          if (!settled) reject(new Error('Payment cancelled.'));
        },
      },
    });
    rzp.on('payment.failed', (resp: any) => {
      settled = true;
      reject(new Error(resp?.error?.description || 'Payment failed. Please try again.'));
    });
    rzp.open();
  });
}

/** Native checkout via the react-native-razorpay native module. */
async function openNativeCheckout(order: CreatedOrder, prefill?: PurchasePrefill): Promise<CheckoutProof> {
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

  return {
    paymentId: data.razorpay_payment_id,
    orderId: data.razorpay_order_id,
    signature: data.razorpay_signature,
  };
}

/**
 * Runs the full coin-purchase flow for a package:
 *   1. Server creates a price-authoritative Razorpay order.
 *   2. The Razorpay checkout collects the payment — web (checkout.js) OR native
 *      (react-native-razorpay), chosen by platform.
 *   3. Server verifies the signature and credits the coins (the webhook also
 *      backstops crediting; the server dedupes so double-credit is impossible).
 *
 * REQUIREMENTS:
 *   - Server secrets RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET configured.
 *   - Native builds: `react-native-razorpay` (custom dev client or EAS build,
 *     NOT Expo Go). Web: no extra setup — checkout.js is loaded on demand.
 *
 * Returns the number of coins credited on success. Throws a user-friendly
 * Error otherwise ("Payment cancelled." for a normal user dismissal).
 */
export async function purchasePackage(
  pkg: { id: string; name?: string },
  prefill?: PurchasePrefill,
): Promise<{ coins: number }> {
  // 1) Server-priced order.
  const order = await walletService.createOrder(pkg.id);

  // 2) Collect payment on the right platform.
  const proof =
    Platform.OS === 'web'
      ? await openWebCheckout(order, prefill)
      : await openNativeCheckout(order, prefill);

  // 3) Server verification + credit (coins are server-authoritative).
  await walletService.confirmTopup(proof);

  return { coins: order.coins };
}
