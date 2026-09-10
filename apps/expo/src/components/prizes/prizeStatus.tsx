/**
 * How each fulfilment status is presented to the WINNER.
 *
 * One place, because the list and the detail screen both show it and they must not
 * disagree about what "approved" means to a user waiting for a parcel.
 *
 * The wording is deliberately about the PARCEL rather than about our queue:
 * "approved" is an operator's word for a row, and what the winner needs to know is
 * that their prize is being packed. `unclaimed` is the only status that is an
 * instruction, because it is the only one that is waiting on them.
 */
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@/src/lib/icons';
import type { PrizeClaimStatus } from '@/src/services/prizes/prizeService';

export interface PrizeStatusMeta {
  /** Short pill label. */
  label: string;
  /** One line explaining where the prize actually is. */
  detail: string;
  color: string;
  icon: string;
  /** True when the winner has to do something before anything else can happen. */
  actionable: boolean;
}

const META: Record<PrizeClaimStatus, PrizeStatusMeta> = {
  unclaimed: {
    label: 'Action needed',
    detail: 'Add your delivery address to claim this prize.',
    color: '#F59E0B',
    icon: 'alert-circle',
    actionable: true,
  },
  submitted: {
    label: 'Address sent',
    detail: "We're checking your address. You can still correct it.",
    color: '#FB923C',
    icon: 'time',
    actionable: false,
  },
  approved: {
    label: 'Packing',
    detail: 'Your address is confirmed and your prize is being packed.',
    color: '#3B82F6',
    icon: 'cube',
    actionable: false,
  },
  shipped: {
    label: 'On the way',
    detail: 'Your prize has been handed to the courier.',
    color: '#6366F1',
    icon: 'car',
    actionable: false,
  },
  delivered: {
    label: 'Delivered',
    detail: 'This prize was delivered. Enjoy!',
    color: '#22C55E',
    icon: 'checkmark-circle',
    actionable: false,
  },
  cancelled: {
    label: 'Cancelled',
    detail: 'This claim was cancelled.',
    color: '#FF4D67',
    icon: 'close-circle',
    actionable: false,
  },
};

/**
 * Meta for a status. An unknown status reads as "submitted" — a state that is
 * neither an instruction to the user nor a promise that anything has been
 * delivered, so a status added server-side before the app knows about it cannot
 * make the app ask for an address it already has, or claim a delivery that has not
 * happened.
 */
export function prizeStatusMeta(status: PrizeClaimStatus | string): PrizeStatusMeta {
  return META[status as PrizeClaimStatus] ?? META.submitted;
}

/** Tinted status pill, matching the withdrawal-history pills in the wallet. */
export function PrizeStatusPill({ status }: { status: PrizeClaimStatus | string }) {
  const meta = prizeStatusMeta(status);
  return (
    <View style={[styles.pill, { backgroundColor: meta.color + '22' }]}>
      <Ionicons name={meta.icon} size={12} color={meta.color} />
      <Text style={[styles.pillText, { color: meta.color }]} numberOfLines={1} maxFontSizeMultiplier={1.3}>
        {meta.label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 20,
  },
  pillText: { fontFamily: 'Urbanist-Bold', fontSize: 12 },
});
