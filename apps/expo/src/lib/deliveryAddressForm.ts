/**
 * The delivery-address rules, client side.
 *
 * A deliberate mirror of `parseDeliveryAddress` in the Worker's
 * lib/deliveryAddress.ts, which is authoritative. The duplication buys something
 * specific: `submitPrizeClaim` is rate-limited to 10 per hour FAIL-CLOSED, so every
 * server rejection for a typo spends part of the budget the user needs in order to
 * FIX that typo. Catching it locally costs nothing.
 *
 * A mirror that drifts is worse than none, though — stricter than the server locks
 * somebody out of a prize they won, looser than the server burns a rate-limit slot
 * on a submit that fails anyway. So the two are pinned to the same explicit table of
 * inputs and expected verdicts, asserted on both sides:
 *
 *   apps/expo/test/deliveryAddressForm.test.ts   (this schema)
 *   apps/worker/test/productPrizes.test.ts       (parseDeliveryAddress)
 *
 * The table is duplicated rather than the import because the two live in separate CI
 * jobs with separate `node_modules`: the Worker's validator reaches `hono` through
 * lib/http.ts, which the Expo job cannot resolve, and the Worker has no `zod`. A
 * shared table asserted twice is what survives that split — and it is a stronger
 * contract than comparing two implementations to each other, because it says out
 * loud what the answer is supposed to be.
 *
 * Lives here, not in the route, so it is importable by a test without dragging in
 * expo-router and the native modules the screen needs.
 *
 * The bounds are WIDE on purpose. A validator that insists on a shape locks somebody
 * out of a prize they have already won, so only the six fields a courier genuinely
 * cannot work without are required.
 */
import { z } from 'zod';

/** Collapse internal whitespace, exactly as the Worker's `text()` does. */
export const collapse = (value: unknown) =>
  typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';

const optional = (max: number, label: string) =>
  z
    .string()
    .optional()
    .transform((v) => collapse(v))
    .refine((v) => v.length <= max, `${label} must be ${max} characters or fewer.`);

export const deliverySchema = z.object({
  recipientName: z
    .string()
    .transform(collapse)
    .refine((v) => v.length >= 2, 'Enter a valid recipient name.')
    .refine((v) => v.length <= 100, 'Recipient name must be 100 characters or fewer.'),
  // Spaces and dashes are stripped and a +91 / 91 prefix accepted, because that is
  // how people type their own number. The Worker strips the prefix before storing.
  phone: z
    .string()
    .transform((v) => collapse(v).replace(/[\s-]/g, ''))
    .refine(
      (v) => /^(?:\+?91)?[6-9]\d{9}$/.test(v),
      'Enter a valid 10-digit mobile number for delivery.',
    ),
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

export type DeliveryFormValues = z.input<typeof deliverySchema>;

export const EMPTY_DELIVERY_FORM: DeliveryFormValues = {
  recipientName: '',
  phone: '',
  addressLine1: '',
  addressLine2: '',
  landmark: '',
  city: '',
  state: '',
  postalCode: '',
  notes: '',
};

/**
 * Longest realistic phone string the input must hold: "+91 98765 43210" is 15
 * characters, and the schema only strips the separators AFTER the input has already
 * truncated. A 14 cap ate the last digit and then reported an invalid number the
 * user had typed correctly.
 */
export const PHONE_INPUT_MAX_LENGTH = 16;
