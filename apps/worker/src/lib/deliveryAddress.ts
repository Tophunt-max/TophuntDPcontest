/**
 * Delivery details for a physical prize.
 *
 * The closest existing precedent is lib/payouts.ts, and the reasoning transfers
 * exactly: `withdrawals.account_details` was free text that reached an admin panel
 * and eventually a real bank transfer completely unvalidated, so a typo was only
 * discovered when the money failed to arrive — or arrived somewhere else. A postal
 * address has the same property. A missing pincode or a two-character name is
 * cheap to catch here and expensive to discover when a courier returns the parcel.
 *
 * These checks reject MALFORMED input, not unusual input. Addresses are messy and
 * a validator that insists on a shape will lock somebody out of a prize they won,
 * so the bounds are wide and only the genuinely load-bearing fields — name, phone,
 * street, city, state, pincode — are required at all.
 */
import { httpsError } from "./http";

/** Indian mobile numbers, optionally +91 prefixed. Same rule as payouts.ts. */
const MOBILE_RE = /^(?:\+?91)?[6-9]\d{9}$/;
/** India Post PIN codes: six digits, never starting at zero. */
const PINCODE_RE = /^[1-9]\d{5}$/;

export interface DeliveryAddress {
  recipientName: string;
  phone: string;
  addressLine1: string;
  addressLine2: string | null;
  landmark: string | null;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  notes: string | null;
}

const LIMITS = {
  recipientName: 100,
  addressLine1: 200,
  addressLine2: 200,
  landmark: 120,
  city: 80,
  state: 80,
  country: 80,
  notes: 500,
} as const;

function text(raw: unknown): string {
  return typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
}

/** A required free-text field with a floor and a ceiling. */
function required(raw: unknown, label: string, max: number, min = 2): string {
  const value = text(raw);
  if (value.length < min) {
    throw httpsError("invalid-argument", `Enter a valid ${label}.`);
  }
  if (value.length > max) {
    throw httpsError("invalid-argument", `${label} must be ${max} characters or fewer.`);
  }
  return value;
}

/** An optional field: empty becomes null rather than "". */
function optional(raw: unknown, label: string, max: number): string | null {
  const value = text(raw);
  if (!value) return null;
  if (value.length > max) {
    throw httpsError("invalid-argument", `${label} must be ${max} characters or fewer.`);
  }
  return value;
}

/**
 * Validate and normalise the address a winner submits.
 *
 * Whitespace is collapsed on every field. That is not cosmetic: these strings are
 * read off a screen by a human packing a parcel, and a name pasted with a newline
 * in it becomes a shipping label with a newline in it.
 */
export function parseDeliveryAddress(raw: unknown): DeliveryAddress {
  if (!raw || typeof raw !== "object") {
    throw httpsError("invalid-argument", "Delivery details are required.");
  }
  const input = raw as Record<string, unknown>;

  const phoneDigits = String(input.phone ?? "").replace(/[\s-]/g, "").trim();
  if (!MOBILE_RE.test(phoneDigits)) {
    throw httpsError("invalid-argument", "Enter a valid 10-digit mobile number for delivery.");
  }

  const postalCode = String(input.postalCode ?? input.pincode ?? "").replace(/\s+/g, "");
  if (!PINCODE_RE.test(postalCode)) {
    throw httpsError("invalid-argument", "Enter a valid 6-digit PIN code.");
  }

  return {
    recipientName: required(input.recipientName ?? input.name, "recipient name", LIMITS.recipientName),
    // Stored without the country code, matching how payouts.ts normalises a Paytm
    // number, so the two places an admin reads a phone number agree.
    phone: phoneDigits.replace(/^\+?91/, ""),
    addressLine1: required(
      input.addressLine1 ?? input.address,
      "house / street address",
      LIMITS.addressLine1,
      4,
    ),
    addressLine2: optional(input.addressLine2, "Address line 2", LIMITS.addressLine2),
    landmark: optional(input.landmark, "Landmark", LIMITS.landmark),
    city: required(input.city, "city", LIMITS.city),
    state: required(input.state, "state", LIMITS.state),
    postalCode,
    // Defaulted rather than required: the app ships to one country today, and
    // making a winner type it is friction on a form that already has eight fields.
    country: optional(input.country, "Country", LIMITS.country) ?? "India",
    notes: optional(input.notes, "Delivery notes", LIMITS.notes),
  };
}

/** Keep the last `keep` characters, mask the rest. Mirrors payouts.ts `maskTail`. */
function maskTail(value: string, keep = 4): string {
  const clean = value.replace(/\s+/g, "");
  if (clean.length <= keep) return "*".repeat(clean.length);
  return `${"*".repeat(clean.length - keep)}${clean.slice(-keep)}`;
}

/**
 * A one-line summary safe for a LIST view, notification or audit entry.
 *
 * Full addresses belong on the one screen where an admin is actually packing the
 * parcel. Putting them in a list means every operator who opens the queue — and
 * every log line that records it — carries a home address and a phone number that
 * nobody needed to see. City, state and PIN are enough to recognise a row.
 */
export function summariseDeliveryAddress(row: {
  recipientName?: string | null;
  phone?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
}): string {
  const parts = [row.city, row.state, row.postalCode].map((p) => (p ? String(p) : "")).filter(Boolean);
  const where = parts.join(", ");
  const name = row.recipientName ? String(row.recipientName) : "";
  const phone = row.phone ? maskTail(String(row.phone)) : "";
  return [name, where, phone].filter(Boolean).join(" · ");
}

/** The full address as a courier-ready block, for the fulfilment screen only. */
export function formatDeliveryAddress(row: {
  recipientName?: string | null;
  phone?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  landmark?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  country?: string | null;
}): string {
  const lines = [
    row.recipientName,
    row.addressLine1,
    row.addressLine2,
    row.landmark ? `Landmark: ${row.landmark}` : null,
    [row.city, row.state].filter(Boolean).join(", ") || null,
    row.postalCode ? `PIN ${row.postalCode}` : null,
    row.country,
    row.phone ? `Phone: ${row.phone}` : null,
  ];
  return lines.filter((l) => l && String(l).trim()).map((l) => String(l).trim()).join("\n");
}
