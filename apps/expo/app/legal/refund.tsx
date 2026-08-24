import { LegalDocument } from '@/src/components/legal/LegalDocument';

/**
 * Refund & cancellation policy.
 *
 * Required by Razorpay for paid digital goods, and previously missing entirely —
 * there was no refund policy anywhere in the app.
 */
export default function RefundPolicyScreen() {
  return (
    <LegalDocument
      docKey="refundPolicy"
      title="Refund Policy"
      emptyMessage="Our refund and cancellation policy has not been published yet. Contact support and we will help with any purchase issue."
    />
  );
}
