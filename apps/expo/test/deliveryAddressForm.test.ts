/**
 * The client half of the delivery-address contract.
 *
 * `src/lib/deliveryAddressForm.ts` mirrors the Worker's `parseDeliveryAddress`, and a
 * mirror that drifts is worse than none: stricter than the server locks somebody out
 * of a prize they won, looser than the server burns one of their 10-per-hour
 * fail-closed submit attempts on a request that fails anyway.
 *
 * `DELIVERY_CASES` below is the contract, and the SAME table is asserted against the
 * Worker's validator in apps/worker/test/productPrizes.test.ts. If either side
 * changes its verdict on any of these inputs, one of the two suites fails.
 *
 * Duplicating the table rather than importing across the two packages is forced by
 * CI: each app's job installs only its own `node_modules`, the Worker's validator
 * reaches `hono` through lib/http.ts (which this job cannot resolve), and the Worker
 * has no `zod`. An explicit expected-verdict table is also a better contract than
 * comparing two implementations to each other — it says what the answer is meant to
 * be, instead of only that the two agree.
 */
import { describe, it, expect } from 'vitest';

import { deliverySchema, PHONE_INPUT_MAX_LENGTH } from '@/src/lib/deliveryAddressForm';

export const VALID_DELIVERY = {
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

/** [label, input, shouldBeAccepted] — mirrored in the worker suite. */
export const DELIVERY_CASES: Array<[string, Record<string, unknown>, boolean]> = [
  ['a complete valid address', VALID_DELIVERY, true],
  ['a +91 prefixed number', { ...VALID_DELIVERY, phone: '+919876543210' }, true],
  ['a 91 prefixed number', { ...VALID_DELIVERY, phone: '919876543210' }, true],
  ['a number typed with spaces and dashes', { ...VALID_DELIVERY, phone: '98765-43210' }, true],
  ['a spaced +91 number', { ...VALID_DELIVERY, phone: '+91 98765 43210' }, true],
  ['a PIN typed with a space', { ...VALID_DELIVERY, postalCode: '560 001' }, true],
  ['extra internal whitespace', { ...VALID_DELIVERY, recipientName: ' Asha   Kumari ', city: ' Bengaluru ' }, true],
  [
    'every optional field populated',
    { ...VALID_DELIVERY, addressLine2: 'HSR Layout', landmark: 'Opp. metro', notes: 'Ring twice' },
    true,
  ],
  ['a name at the 100 limit', { ...VALID_DELIVERY, recipientName: 'a'.repeat(100) }, true],
  ['a PIN starting with 9', { ...VALID_DELIVERY, postalCode: '900001' }, true],

  ['a landline-style number', { ...VALID_DELIVERY, phone: '1234567890' }, false],
  ['a number starting below 6', { ...VALID_DELIVERY, phone: '5876543210' }, false],
  ['a 9-digit number', { ...VALID_DELIVERY, phone: '987654321' }, false],
  ['an 11-digit number', { ...VALID_DELIVERY, phone: '98765432109' }, false],
  ['a blank phone', { ...VALID_DELIVERY, phone: '' }, false],
  ['a PIN starting with 0', { ...VALID_DELIVERY, postalCode: '060001' }, false],
  ['a 5-digit PIN', { ...VALID_DELIVERY, postalCode: '56001' }, false],
  ['a 7-digit PIN', { ...VALID_DELIVERY, postalCode: '5600011' }, false],
  ['a PIN with letters', { ...VALID_DELIVERY, postalCode: '56000A' }, false],
  ['a one-character name', { ...VALID_DELIVERY, recipientName: 'A' }, false],
  ['a blank name', { ...VALID_DELIVERY, recipientName: '   ' }, false],
  ['a 3-character street address', { ...VALID_DELIVERY, addressLine1: '12A' }, false],
  ['a blank street address', { ...VALID_DELIVERY, addressLine1: '' }, false],
  ['a one-character city', { ...VALID_DELIVERY, city: 'B' }, false],
  ['a blank city', { ...VALID_DELIVERY, city: '' }, false],
  ['a one-character state', { ...VALID_DELIVERY, state: 'K' }, false],
  ['a blank state', { ...VALID_DELIVERY, state: '' }, false],
  ['an over-long name', { ...VALID_DELIVERY, recipientName: 'a'.repeat(101) }, false],
  ['an over-long street address', { ...VALID_DELIVERY, addressLine1: 'a'.repeat(201) }, false],
  ['an over-long city', { ...VALID_DELIVERY, city: 'a'.repeat(81) }, false],
  ['an over-long address line 2', { ...VALID_DELIVERY, addressLine2: 'a'.repeat(201) }, false],
  ['an over-long landmark', { ...VALID_DELIVERY, landmark: 'a'.repeat(121) }, false],
  ['over-long notes', { ...VALID_DELIVERY, notes: 'a'.repeat(501) }, false],
];

describe('delivery address form schema', () => {
  it.each(DELIVERY_CASES)('%s -> accepted: %s', (_label, input, accepted) => {
    expect(deliverySchema.safeParse(input).success).toBe(accepted);
  });

  it('collapses whitespace, because these strings become a shipping label', () => {
    const parsed = deliverySchema.parse({ ...VALID_DELIVERY, recipientName: ' Asha   Kumari\n' });
    expect(parsed.recipientName).toBe('Asha Kumari');
  });

  it('strips separators from the PIN and the phone', () => {
    const parsed = deliverySchema.parse({ ...VALID_DELIVERY, postalCode: '560 001', phone: '98765-43210' });
    expect(parsed.postalCode).toBe('560001');
    expect(parsed.phone).toBe('9876543210');
  });

  it('treats exactly six fields as required', () => {
    for (const field of ['recipientName', 'phone', 'addressLine1', 'city', 'state', 'postalCode']) {
      expect(deliverySchema.safeParse({ ...VALID_DELIVERY, [field]: '' }).success, `${field} must be required`).toBe(false);
    }
    for (const field of ['addressLine2', 'landmark', 'notes']) {
      expect(deliverySchema.safeParse({ ...VALID_DELIVERY, [field]: '' }).success, `${field} must be optional`).toBe(true);
    }
  });

  it('accepts a phone as long as the input is allowed to hold', () => {
    // The separators are only stripped after the input has already truncated, so the
    // cap has to fit the longest format a user might type.
    const longest = '+91 98765 43210';
    expect(longest.length).toBeLessThanOrEqual(PHONE_INPUT_MAX_LENGTH);
    expect(deliverySchema.safeParse({ ...VALID_DELIVERY, phone: longest }).success).toBe(true);
  });
});
