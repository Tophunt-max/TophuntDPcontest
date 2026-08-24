import React, { useCallback } from 'react';
import { TouchableOpacity, useColorScheme, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { useRouter } from 'expo-router';
import { ArrowIcon } from './ArrowIcon';

/**
 * The single back arrow for the whole app.
 *
 * Every screen used to roll its own: some pulled `chevron-back` from the
 * Ionicons shim, others rendered `Left_Arrow` from assets directly, with hit
 * areas ranging from "none" to 40x40 and accessibility labels only sometimes
 * present. This component is now the one place that decides what "back" looks
 * and behaves like — always `left_arrow.svg` (via ArrowIcon), never Ionicons.
 *
 * `size` acts as the glyph HEIGHT; see ArrowIcon for why.
 */
export type BackButtonProps = {
    /** Glyph height in px. Default 24. */
    size?: number;
    /** Stroke colour. Defaults to the current theme's text colour. */
    color?: string;
    /** Override the default `router.back()` behaviour. */
    onPress?: () => void;
    style?: StyleProp<ViewStyle>;
    accessibilityLabel?: string;
    /** Set false to render just the icon with no touch handling. */
    pressable?: boolean;
};

export function BackButton({
    size = 24,
    color,
    onPress,
    style,
    accessibilityLabel = 'Go back',
    pressable = true,
}: BackButtonProps) {
    const router = useRouter();
    const isDark = useColorScheme() === 'dark';
    // Kept in sync with the header text colour screens already use.
    const tint = color ?? (isDark ? '#FFFFFF' : '#101014');

    const handlePress = useCallback(() => {
        if (onPress) {
            onPress();
            return;
        }
        router.back();
    }, [onPress, router]);

    const icon = <ArrowIcon size={size} color={tint} direction="left" />;

    if (!pressable) return icon;

    return (
        <TouchableOpacity
            onPress={handlePress}
            style={[styles.button, style]}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={accessibilityLabel}
        >
            {icon}
        </TouchableOpacity>
    );
}

const styles = StyleSheet.create({
    button: {
        // Comfortably above the 44pt minimum once hitSlop is counted.
        minWidth: 40,
        height: 40,
        alignItems: 'center',
        justifyContent: 'center',
    },
});

export default BackButton;
