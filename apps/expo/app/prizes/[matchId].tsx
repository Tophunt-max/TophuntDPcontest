/**
 * One prize, and the delivery address that claims it.
 *
 * Addressed by MATCH id, not claim id, because that is what the notification's
 * `targetId` (`prize:<matchId>`) carries — the winning push deep-links straight
 * here, which is the whole point: the user is one tap from the form they must fill
 * in to receive what they won.
 *
 * ---------------------------------------------------------------------------
 * Validation mirrors the server, deliberately
 * ---------------------------------------------------------------------------
 * Every rule below is a copy of `parseDeliveryAddress` in the Worker's
 * lib/deliveryAddress.ts. Duplicating it is worth it here: the submit is
 * rate-limited to 10 per hour FAIL-CLOSED, so every round trip rejected for a typo
 * spends part of a budget the user needs in order to fix that typo. Catching it
 * locally costs nothing.
 *
 * The bounds are wide on purpose. A validator that insists on a shape locks
 * somebody out of a prize they have already won, so only the six fields a courier
 * genuinely cannot work without are required.
 */
import React, { useEffect, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  SafeAreaView,
  ScrollView,
  ActivityIndicator,
  TouchableOpacity,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import * as Haptics from 'expo-haptics';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { Ionicons } from '@/src/lib/icons';
import { Alert } from '@/src/lib/appAlert';
import { AppImage as Image } from '@/src/components/ui/AppImage';
import { BackButton } from '@/src/components/ui/BackButton';
import { FormInput } from '@/src/components/inputs/FormInput';
import { PrimaryButton } from '@/src/components/buttons/PrimaryButton';
import { EmptyState, ErrorState } from '@/src/components/ui/StateViews';
import { PrizeStatusPill, prizeStatusMeta } from '@/src/components/prizes/prizeStatus';
import { usePrize, useSubmitPrizeClaim } from '@/src/hooks/usePrizes';
import { Colors } from '@/constants/theme';

/** Collapse internal whitespace, exactly as the Worker's `text()` does. */
const collapse = (value: unknown) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '');

const optional = (max: number, label: string) =>
  z
    .string()
    .optional()
    .transform((v) => collapse(v))
    .refine((v) => v.length <= max, `${label} must be ${max} characters or fewer.`);

const deliverySchema = z.object({
  recipientName: z
    .string()
    .transform(collapse)
    .refine((v) => v.length >= 2, 'Enter a valid recipient name.')
    .refine((v) => v.length <= 100, 'Recipient name must be 100 characters or fewer.'),
  // Spaces and dashes are stripped before the check, and a +91 / 91 prefix is
  // accepted, because that is how people type their own number.
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

type DeliveryFormValues = z.input<typeof deliverySchema>;

const EMPTY_FORM: DeliveryFormValues = {
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

export default function PrizeClaimScreen() {
  const params = useLocalSearchParams();
  const matchId = String(params.matchId || '');

  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  const backgroundColor = isDark ? Colors.dark.background : '#F8F9FA';
  const cardBg = isDark ? '#1F222A' : '#FFFFFF';
  const textColor = isDark ? Colors.dark.text : '#121212';
  const subTextColor = isDark ? '#A0A0A0' : '#757575';
  const borderColor = isDark ? '#23262D' : '#EEF0F4';

  const { claim, pending, isError, refetch } = usePrize(matchId);
  const submitMut = useSubmitPrizeClaim();

  const meta = claim ? prizeStatusMeta(claim.status) : null;

  const {
    control,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<DeliveryFormValues>({
    resolver: zodResolver(deliverySchema) as any,
    defaultValues: EMPTY_FORM,
  });

  // Prefill from the address already on file, so "correct my address" is an edit
  // rather than a retype. Runs when the claim arrives, and again if it changes.
  const delivery = claim?.delivery;
  const prefill = useMemo<DeliveryFormValues | null>(
    () =>
      delivery
        ? {
            recipientName: delivery.recipientName || '',
            phone: delivery.phone || '',
            addressLine1: delivery.addressLine1 || '',
            addressLine2: delivery.addressLine2 || '',
            landmark: delivery.landmark || '',
            city: delivery.city || '',
            state: delivery.state || '',
            postalCode: delivery.postalCode || '',
            notes: delivery.notes || '',
          }
        : null,
    [delivery],
  );

  useEffect(() => {
    if (prefill) reset(prefill);
  }, [prefill, reset]);

  const onSubmit = async (values: DeliveryFormValues) => {
    if (!claim) return;
    try {
      // Parse once more so the server receives the SAME normalised strings the
      // schema validated — the raw form values still carry the user's spacing, and
      // these become a shipping label.
      const parsed = deliverySchema.parse(values);
      // `submitPrizeClaim` overwrites the WHOLE address block, and this form has no
      // country field (it is India for every prize we ship). Carrying the stored
      // value back means correcting a typo cannot silently rewrite the country of an
      // address that was not India.
      const delivery = { ...parsed, country: claim.delivery?.country ?? undefined };
      await submitMut.mutateAsync({ matchId: claim.matchId, delivery });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert(
        'Address saved',
        "We'll check it and start packing your prize. You can still correct it until we do.",
      );
      router.back();
    } catch (e: any) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      // The Worker's own message is the useful one: it distinguishes "too late to
      // change this" from a validation failure, and names the rate limit.
      Alert.alert('Could not save your address', e?.message || 'Please try again.');
    }
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor }]}>
      <View style={[styles.header, { borderBottomColor: borderColor }]}>
        <BackButton size={24} color={textColor} style={styles.backBtn} />
        <View style={styles.titleWrap}>
          <Ionicons name="cube" size={16} color="#A78BFA" />
          <Text style={[styles.title, { color: textColor }]}>Your Prize</Text>
        </View>
        <View style={styles.backBtn} />
      </View>

      {pending ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color="#FF4D67" />
        </View>
      ) : isError ? (
        <ErrorState
          title="Could not load this prize"
          subtitle="Check your connection and try again — nothing you have won is lost."
          onAction={refetch}
        />
      ) : !claim || !meta ? (
        <EmptyState
          icon="cube-outline"
          title="Prize not found"
          subtitle="This prize is not on your account. If you think that is wrong, contact support."
        />
      ) : (
        <KeyboardAvoidingView
          style={styles.flex}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
            {/* What was won */}
            <View style={[styles.prizeCard, { backgroundColor: cardBg, borderColor }]}>
              <View style={[styles.prizeImageWrap, { backgroundColor: borderColor }]}>
                {claim.productImageUrl ? (
                  <Image source={{ uri: claim.productImageUrl }} style={styles.prizeImage} contentFit="cover" />
                ) : (
                  <Ionicons name="cube" size={40} color={subTextColor} />
                )}
              </View>
              <Text style={[styles.prizeTitle, { color: textColor }]}>{claim.productTitle}</Text>
              {claim.productValue > 0 && (
                <Text style={[styles.prizeValue, { color: subTextColor }]}>Worth ₹{claim.productValue}</Text>
              )}
              <View style={styles.pillRow}>
                <PrizeStatusPill status={claim.status} />
              </View>
              <Text style={[styles.prizeDetail, { color: subTextColor }]}>
                {claim.status === 'cancelled' && claim.adminNote ? claim.adminNote : meta.detail}
              </Text>
            </View>

            {/* Tracking, once there is any */}
            {/* Gated on the tracking number itself, not on `status === 'shipped'`:
                a delivered parcel still has a tracking number, and hiding it the
                moment it is marked delivered removes the only proof the winner has
                if it never actually arrived. */}
            {claim.trackingNumber && (
              <View style={[styles.section, { backgroundColor: cardBg, borderColor }]}>
                <Text style={[styles.sectionTitle, { color: textColor }]}>Tracking</Text>
                <Text style={[styles.trackingCourier, { color: textColor }]}>{claim.courier}</Text>
                <Text style={[styles.trackingNumber, { color: subTextColor }]} selectable>
                  {claim.trackingNumber}
                </Text>
                <Text style={[styles.hint, { color: subTextColor }]}>
                  Track this number on the courier&apos;s own website.
                </Text>
              </View>
            )}

            {/* The address, editable or frozen */}
            {claim.canEditAddress ? (
              <View style={[styles.section, { backgroundColor: cardBg, borderColor }]}>
                <Text style={[styles.sectionTitle, { color: textColor }]}>
                  {claim.hasAddress ? 'Correct your delivery address' : 'Where should we send it?'}
                </Text>
                <Text style={[styles.hint, { color: subTextColor, marginBottom: 14 }]}>
                  {claim.hasAddress
                    ? 'You can change this until we start packing your prize.'
                    : 'We need this before your prize can be shipped. Only you and our delivery team see it.'}
                </Text>

                <FormInput
                  control={control}
                  name="recipientName"
                  placeholder="Full name of who receives it *"
                  autoCapitalize="words"
                  maxLength={100}
                  errorMessage={errors.recipientName?.message}
                />
                <FormInput
                  control={control}
                  name="phone"
                  placeholder="10-digit mobile number *"
                  keyboardType="phone-pad"
                  // 16, not 14: the schema strips spaces, dashes and a +91 prefix,
                  // but only AFTER the input has already truncated. "+91 98765 43210"
                  // is 15 characters, so a 14 cap ate the last digit and then
                  // reported an invalid number the user had typed correctly.
                  maxLength={16}
                  errorMessage={errors.phone?.message}
                />
                <FormInput
                  control={control}
                  name="addressLine1"
                  placeholder="House number and street *"
                  maxLength={200}
                  errorMessage={errors.addressLine1?.message}
                />
                <FormInput
                  control={control}
                  name="addressLine2"
                  placeholder="Area, colony (optional)"
                  maxLength={200}
                  errorMessage={errors.addressLine2?.message}
                />
                <FormInput
                  control={control}
                  name="landmark"
                  placeholder="Nearby landmark (optional)"
                  maxLength={120}
                  errorMessage={errors.landmark?.message}
                />
                <FormInput
                  control={control}
                  name="city"
                  placeholder="City *"
                  autoCapitalize="words"
                  maxLength={80}
                  errorMessage={errors.city?.message}
                />
                <FormInput
                  control={control}
                  name="state"
                  placeholder="State *"
                  autoCapitalize="words"
                  maxLength={80}
                  errorMessage={errors.state?.message}
                />
                <FormInput
                  control={control}
                  name="postalCode"
                  placeholder="6-digit PIN code *"
                  keyboardType="number-pad"
                  maxLength={6}
                  errorMessage={errors.postalCode?.message}
                />
                <FormInput
                  control={control}
                  name="notes"
                  placeholder="Delivery instructions (optional)"
                  maxLength={500}
                  errorMessage={errors.notes?.message}
                />

                <PrimaryButton
                  title={claim.hasAddress ? 'Update address' : 'Claim my prize'}
                  onPress={handleSubmit(onSubmit)}
                  isLoading={submitMut.isPending}
                />
              </View>
            ) : (
              delivery && (
                <View style={[styles.section, { backgroundColor: cardBg, borderColor }]}>
                  <Text style={[styles.sectionTitle, { color: textColor }]}>Delivering to</Text>
                  <Text style={[styles.addressBlock, { color: textColor }]}>
                    {[
                      delivery.recipientName,
                      delivery.addressLine1,
                      delivery.addressLine2,
                      delivery.landmark ? `Landmark: ${delivery.landmark}` : '',
                      [delivery.city, delivery.state].filter(Boolean).join(', '),
                      delivery.postalCode ? `PIN ${delivery.postalCode}` : '',
                      delivery.country,
                      delivery.phone ? `Phone: ${delivery.phone}` : '',
                    ]
                      .filter(Boolean)
                      .join('\n')}
                  </Text>
                  <Text style={[styles.hint, { color: subTextColor }]}>
                    This address is locked now that your prize is on its way. If something is wrong, contact support
                    straight away.
                  </Text>
                  <TouchableOpacity onPress={() => router.push('/setting/report')} style={styles.supportLink}>
                    <Text style={styles.supportLinkText}>Contact support</Text>
                  </TouchableOpacity>
                </View>
              )
            )}
          </ScrollView>
        </KeyboardAvoidingView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  flex: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderBottomWidth: 1,
  },
  backBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  titleWrap: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  title: { fontFamily: 'Urbanist-Bold', fontSize: 18 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  scroll: { padding: 16, paddingBottom: 48, gap: 14 },

  prizeCard: { borderRadius: 18, borderWidth: 1, padding: 18, alignItems: 'center', gap: 6 },
  prizeImageWrap: {
    width: 120,
    height: 120,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    marginBottom: 6,
  },
  prizeImage: { width: '100%', height: '100%' },
  prizeTitle: { fontFamily: 'Urbanist-Bold', fontSize: 19, textAlign: 'center', lineHeight: 24 },
  prizeValue: { fontFamily: 'Urbanist-SemiBold', fontSize: 13 },
  pillRow: { flexDirection: 'row', marginTop: 4 },
  prizeDetail: {
    fontFamily: 'Urbanist-Medium',
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'center',
    marginTop: 4,
  },

  section: { borderRadius: 18, borderWidth: 1, padding: 16 },
  sectionTitle: { fontFamily: 'Urbanist-Bold', fontSize: 16, marginBottom: 4 },
  hint: { fontFamily: 'Urbanist-Medium', fontSize: 12, lineHeight: 17 },
  addressBlock: { fontFamily: 'Urbanist-SemiBold', fontSize: 14, lineHeight: 21, marginBottom: 10 },
  trackingCourier: { fontFamily: 'Urbanist-Bold', fontSize: 15, marginTop: 4 },
  trackingNumber: { fontFamily: 'Urbanist-SemiBold', fontSize: 14, marginBottom: 8 },
  supportLink: { marginTop: 12 },
  supportLinkText: { color: '#FF4D67', fontFamily: 'Urbanist-Bold', fontSize: 14 },
});
