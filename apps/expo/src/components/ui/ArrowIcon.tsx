import React from 'react';
import { StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { Left_Arrow, Arrow_Right } from '@/assets/svgs';

/**
 * The only directional arrow in the app.
 *
 * The project ships exactly two arrow assets and each covers both of its
 * directions by being mirrored on the X axis, so there is no second file to
 * drift out of sync:
 *
 *   variant="chevron"  left_arrow.svg   `<`  /  mirrored `>`
 *   variant="arrow"    arrow_right.svg  `→`  /  mirrored `←`
 *
 * The two variants are not interchangeable. A chevron is a navigation or
 * disclosure affordance ("go back", "this row opens"); an arrow has a shaft and
 * reads as "proceed", which is why it belongs in call-to-action buttons. Using
 * a mirrored chevron for a CTA would render `>` where the design wants `→`.
 *
 * Both assets stroke with `currentColor`, so `color` is what themes them —
 * `fill` does nothing.
 *
 * SIZING: `size` is the bounding box, and because both assets preserve their
 * aspect ratio the rendered glyph height is `size`. The chevron's viewBox is
 * 10x16, so it ends up ~0.63x as wide as it is tall; the arrow's is square.
 *
 * Arrows here are decorative — the label or the pressable wrapping them carries
 * the meaning — so they are hidden from screen readers to avoid double
 * announcements.
 */
export type ArrowIconProps = {
    /** Bounding box in px; also the rendered glyph height. Default 24. */
    size?: number;
    /** Stroke colour. Both assets stroke with `currentColor`. */
    color?: string;
    /** Which way it points. Default 'left' for chevron, 'right' for arrow. */
    direction?: 'left' | 'right';
    /** 'chevron' for navigation/disclosure, 'arrow' for CTAs. Default 'chevron'. */
    variant?: 'chevron' | 'arrow';
    style?: StyleProp<ViewStyle>;
};

// Hoisted so a mirrored arrow doesn't allocate a new style object per render —
// these render inside list rows, where that adds up.
const styles = StyleSheet.create({
    mirrored: { transform: [{ scaleX: -1 }] },
});

function ArrowIconComponent({ size = 24, color, direction, variant = 'chevron', style }: ArrowIconProps) {
    // Each asset already points the way its variant is most often used, so the
    // default direction differs and neither common case pays for a transform.
    const isChevron = variant === 'chevron';
    const dir = direction ?? (isChevron ? 'left' : 'right');
    const Glyph = isChevron ? Left_Arrow : Arrow_Right;
    const needsMirror = isChevron ? dir === 'right' : dir === 'left';

    return (
        <Glyph
            width={size}
            height={size}
            color={color}
            style={needsMirror ? [styles.mirrored, style] : style}
            accessible={false}
            importantForAccessibility="no-hide-descendants"
            // Lets the parent Touchable own the press area rather than the SVG
            // swallowing taps aimed at its edges.
            pointerEvents="none"
        />
    );
}

/** Props are primitives, so memoising cuts re-renders in long lists for free. */
export const ArrowIcon = React.memo(ArrowIconComponent);
ArrowIcon.displayName = 'ArrowIcon';

export default ArrowIcon;
