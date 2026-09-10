/**
 * The delivery-address rules exist twice: the Worker's `parseDeliveryAddress` is
 * authoritative, and the claim form (`app/prizes/[matchId].tsx`) mirrors it in zod
 * so a typo is caught before a round trip.
 *
 * The duplication is deliberate — `submitPrizeClaim` is rate-limited to 10/hour
 * FAIL-CLOSED, so every server rejection for a typo spends part of the budget the
 * user needs in order to FIX that typo. But a mirror that drifts is worse than none:
 * a client stricter than the server locks somebody out of a prize they won, and a
 * client looser than the server sends a submit that burns a rate-limit slot and
 * fails anyway.
 *
 * A comment cannot fail CI. This can.
 *
 * The schema is re-declared here rather than imported because it lives inside a
 * `.tsx` route module that pulls in expo-router, react-hook-form and native-only
 * modules. Keeping the copy in the test means the assertions below are what pins it;
 * if the screen's rules change without this file changing, the parity claim is what
 * breaks, which is the failure worth having.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';

import { parseDeliveryAddress } from '../../worker/src/lib/deliveryAddress';

const collapse = (value: unknown) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '');

const optional = (max: number, label: string) =>
  z
    .string()
    .optional()
    .transform((v) => collapse(v))
    .refine((v) => v.length <= max, `${label} must be ${max} characters or fewer.`);

/** Must stay identical to the schema in app/prizes/[matchId].tsx. */
const deliverySchema = z.object({
  recipientName: z
    .string()
    .transform(collapse)
    .refine((v) => v.length >= 2, 'Enter a valid recipient name.')
    .refine((v) => v.length <= 100, 'Recipient name must be 100 characters or fewer.'),
  phone: z
    .string()
    .transform((v) => collapse(v).replace(/[\s-]/g, ''))
    .refine((v) => /^(?:\+?91)?[6-9]\d{9}$/.test(v), 'Enter a valid 10-digit mobile number for delivery.'),
  addressLine1: z
    .string()
    .transform(collapse)
    .refine((v) => v.length >= 4, 'Enter a valid house / street address.')
    .refine((v) => v.length <= 200, 'House / street address must be 200 characters or fewer.'),
  addressLine2: optional(200, 'Address line 2'),
  landmark: optional(120, 'Landmark'),
  city: z
    .string()
    .transform(collapse)
    .refine((v) => v.length >= 2, 'Enter a valid city.')
    .refine((v) => v.length <= 80, 'City must be 80 characters or fewer.'),
  state: z
    .string()
    .transform(collapse)
    .refine((v) => v.length >= 2, 'Enter a valid state.')
    .refine((v) => v.length <= 80, 'State must be 80 characters or fewer.'),
  postalCode: z
    .string()
    .transform((v) => collapse(v).replace(/\s/g, ''))
    .refine((v) => /^[1-9]\d{5}$/.test(v), 'Enter a valid 6-digit PIN code.'),
  notes: optional(500, 'Delivery notes'),
});

const clientAccepts = (input: Record<string, unknown>) => deliverySchema.safeParse(input).success;
const serverAccepts = (input: Record<string, unknown>) => {
  try {
    parseDeliveryAddress(input);
    return true;
  } catch {
    return false;
  }
};

const VALID = {
  recipientName: 'Asha Kumari',
  phone: '9876543210',
  addressLine1: '12 MG Road, Flat 4B',
  addressLine2: '',
  landmark: '',
  city: 'Bengaluru',
  state: 'Karnataka',
  postalCode: '560001',
  notes: '',
};

describe('delivery address: client form and Worker agree', () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['a complete valid address', VALID],
    ['a +91 prefixed number', { ...VALID, phone: '+919876543210' }],
    ['a 91 prefixed number', { ...VALID, phone: '919876543210' }],
    ['a number typed with spaces and dashes', { ...VALID, phone: '98765-43210' }],
    ['a PIN typed with a space', { ...VALID, postalCode: '560 001' }],
    ['extra internal whitespace everywhere', { ...VALID, recipientName: ' Asha   Kumari ', city: ' Bengaluru ' }],
    ['every optional field populated', { ...VALID, addressLine2: 'HSR Layout', landmark: 'Opp. metro', notes: 'Ring twice' }],
    // Rejections
    ['a landline-style number', { ...VALID, phone: '1234567890' }],
    ['a number starting below 6', { ...VALID, phone: '5876543210' }],
    ['a 9-digit number', { ...VALID, phone: '987654321' }],
    ['an 11-digit number', { ...VALID, phone: '98765432109' }],
    ['a PIN starting with 0', { ...VALID, postalCode: '060001' }],
    ['a 5-digit PIN', { ...VALID, postalCode: '56001' }],
    ['a 7-digit PIN', { ...VALID, postalCode: '5600011' }],
    ['a PIN with letters', { ...VALID, postalCode: '56000A' }],
    ['a one-character name', { ...VALID, recipientName: 'A' }],
    ['a blank name', { ...VALID, recipientName: '   ' }],
    ['a 3-character street address', { ...VALID, addressLine1: '12A' }],
    ['a one-character city', { ...VALID, city: 'B' }],
    ['a one-character state', { ...VALID, state: 'K' }],
    ['an over-long name', { ...VALID, recipientName: 'a'.repeat(101) }],
    ['an over-long street address', { ...VALID, addressLine1: 'a'.repeat(201) }],
    ['an over-long city', { ...VALID, city: 'a'.repeat(81) }],
    ['an over-long address line 2', { ...VALID, addressLine2: 'a'.repeat(201) }],
    ['an over-long landmark', { ...VALID, landmark: 'a'.repeat(121) }],
    ['over-long notes', { ...VALID, notes: 'a'.repeat(501) }],
  ];

  it.each(cases)('reaches the same verdict on %s', (_label, input) => {
    expect(clientAccepts(input)).toBe(serverAccepts(input));
  });

  it('normalises the accepted values identically', () => {
    // Both must collapse whitespace and strip the country code, because these
    // strings become a shipping label and the admin screens format them verbatim.
    const messy = { ...VALID, recipientName: ' Asha   Kumari\n', phone: '+91 98765 43210', postalCode: '560 001' };
    const client = deliverySchema.parse(messy);
    const server = parseDeliveryAddress(messy);

    expect(client.recipientName).toBe(server.recipientName);
    expect(client.postalCode).toBe(server.postalCode);
    // The client keeps the prefix it validated; the SERVER is what strips it, and it
    // is the stored value. Asserting the client does not have to duplicate that
    // normalisation, only that it accepts the same input.
    expect(server.phone).toBe('9876543210');
  });

  it('requires exactly the six fields a courier cannot work without', () => {
    for (const field of ['recipientName', 'phone', 'addressLine1', 'city', 'state', 'postalCode']) {
      const without = { ...VALID, [field]: '' };
      expect(clientAccepts(without), `client should reject a blank ${field}`).toBe(false);
      expect(serverAccepts(without), `server should reject a blank ${field}`).toBe(false);
    }
    for (const field of ['addressLine2', 'landmark', 'notes']) {
      const without = { ...VALID, [field]: '' };
      expect(clientAccepts(without), `client should accept a blank ${field}`).toBe(true);
      expect(serverAccepts(without), `server should accept a blank ${field}`).toBe(true);
    }
  });

  it('accepts a phone the form input can actually hold', () => {
    // The input caps at 16 characters. "+91 98765 43210" is 15, so the longest
    // realistic format survives; a 14 cap silently ate the last digit and then
    // reported an invalid number.
    const longest = '+91 98765 43210';
    expect(longest.length).toBeLessThanOrEqual(16);
    expect(clientAccepts({ ...VALID, phone: longest })).toBe(true);
  });
});
