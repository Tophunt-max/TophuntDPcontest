import React from 'react';
import { type StyleProp, type ViewStyle } from 'react-native';
import { Left_Arrow } from '@/assets/svgs';

/**
 * The one arrow glyph in the app.
 *
 * `assets/svgs/left_arrow.svg` is the only chevron asset the project ships, so
 * a right-pointing arrow is the same file mirrored on the X axis rather than a
 * second asset that could drift out of sync with it. Everything that needs a
 * directional chevron — back buttons, the date picker's month stepper — goes
 * through here, so `left_arrow.svg` has exactly one importer.
 *
 * The asset's viewBox is 10x16, so `size` behaves as the glyph HEIGHT: the SVG
 * keeps its aspect ratio inside the box and ends up ~0.63x as wide.
 */
export type ArrowIconProps = {
    /** Glyph height in px. Default 24. */
    size?: number;
    /** Stroke colour. `left_arrow.svg` strokes with `currentColor`. */
    color?: string;
    /** Which way the chevron points. Default 'left'. */
    direction?: 'left' | 'right';
    style?: StyleProp<ViewStyle>;
};

export function ArrowIcon({ size = 24, color, direction = 'left', style }: ArrowIconProps) {
    return (
        <Left_Arrow
            width={size}
            height={size}
            color={color}
            style={[direction === 'right' && { transform: [{ scaleX: -1 }] }, style]}
        />
    );
}

export default ArrowIcon;
