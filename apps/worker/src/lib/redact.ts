/**
 * Mask contact and payment details in free text shown to moderators.
 *
 * Support tickets are written by users and routinely contain a phone number, a
 * UPI id, a bank account and IFSC, or a payment reference (UTR). Moderators answer
 * tickets but must not see payment identifiers (the same rule that strips email,
 * phone and device id from user rows for them), so the text is masked before it
 * leaves the server. Full admins see the original.
 */
const RULES: Array<[RegExp, string]> = [
  // Email addresses and UPI ids (name@bank) — both are user@domain-shaped.
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g, "[email/UPI hidden]"],
  // IFSC codes: 4 letters, a zero, 6 alphanumerics.
  [/\b[A-Z]{4}0[A-Z0-9]{6}\b/gi, "[IFSC hidden]"],
  // Long digit runs (phone, account, card, UTR), allowing spaces or dashes.
  [/(?:\+?\d[\s-]?){9,}\d/g, "[number hidden]"],
];

export function redactPaymentDetails(text: string | null | undefined): string | null {
  if (text == null) return null;
  let out = String(text);
  for (const [re, mask] of RULES) out = out.replace(re, mask);
  return out;
}
