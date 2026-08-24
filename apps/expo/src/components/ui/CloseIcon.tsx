import React from 'react';
import { type StyleProp, type ViewStyle } from 'react-native';
import { Close_X, Close_Circle_Outline } from '@/assets/svgs';

/**
 * The only close/dismiss glyph in the app.
 *
 * Sibling of ArrowIcon, and here for the same reason: the 16 close buttons had
 * drifted into a mix of Ionicons `close` and `close-circle` at seven different
 * sizes, wrapped in TouchableOpacity or Pressable more or less at random.
 *
 *   variant="plain"   close.svg                  X    dismiss a screen/sheet
 *   variant="circle"  close_circle_outline.svg  (X)   clear a field, remove a chip
 *
 * Both assets use lucide's `x` and `circle-x` geometry, which is what the
 * Ionicons shim already resolved to, so nothing changes visually.
 *
 * Deliberately icon-only, with no pressable wrapper. Unlike back buttons, close
 * controls sit in wildly different layouts — a story overlay, an inline text
 * field, a banner row — each with its own hit area and handler. Forcing them
 * into one button component would move pixels for no consistency gain, so the
 * call sites keep their wrappers and only the glyph is shared.
 *
 * Both assets stroke with `currentColor`, so `color` is what themes them.
 *
 * Decorative: the wrapping pressable carries the accessibility label, so this is
 * hidden from screen readers to avoid a double announcement.
 */
export type CloseIconProps = {
    /** Bounding box in px; also the rendered glyph size. Default 24. */
    size?: number;
    /** Stroke colour. Both assets stroke with `currentColor`. */
    color?: string;
    /** 'plain' for dismiss, 'circle' for clear/remove. Default 'plain'. */
    variant?: 'plain' | 'circle';
    style?: StyleProp<ViewStyle>;
};

function CloseIconComponent({ size = 24, color, variant = 'plain', style }: CloseIconProps) {
    const Glyph = variant === 'circle' ? Close_Circle_Outline : Close_X;

    return (
        <Glyph
            width={size}
            height={size}
            color={color}
            style={style}
            accessible={false}
            importantForAccessibility="no-hide-descendants"
            // Lets the parent pressable own the press area rather than the SVG
            // swallowing taps aimed at its edges.
            pointerEvents="none"
        />
    );
}

/** Props are primitives, so memoising cuts re-renders in long lists for free. */
export const CloseIcon = React.memo(CloseIconComponent);
CloseIcon.displayName = 'CloseIcon';

export default CloseIcon;
