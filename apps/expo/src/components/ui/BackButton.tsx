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
 * `size` is the glyph height; see ArrowIcon for the sizing rules.
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
    /** Disables the press while leaving the icon visible. */
    disabled?: boolean;
    /** Test handle for e2e/unit selectors. */
    testID?: string;
};

function BackButtonComponent({
    size = 24,
    color,
    onPress,
    style,
    accessibilityLabel = 'Go back',
    pressable = true,
    disabled = false,
    testID,
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
        // `back()` throws if this is the first screen in the stack (deep link,
        // notification tap). Fall back to the app root so the button is never a
        // dead end.
        if (router.canGoBack()) {
            router.back();
        } else {
            router.replace('/home');
        }
    }, [onPress, router]);

    const icon = <ArrowIcon size={size} color={tint} variant="chevron" direction="left" />;

    if (!pressable) return icon;

    return (
        <TouchableOpacity
            onPress={handlePress}
            disabled={disabled}
            style={[styles.button, style]}
            hitSlop={HIT_SLOP}
            accessibilityRole="button"
            accessibilityLabel={accessibilityLabel}
            accessibilityState={{ disabled }}
            testID={testID}
        >
            {icon}
        </TouchableOpacity>
    );
}

// Hoisted: a fresh object here would break TouchableOpacity's prop equality.
const HIT_SLOP = { top: 8, bottom: 8, left: 8, right: 8 } as const;

const styles = StyleSheet.create({
    button: {
        // 40 + 8pt hitSlop each side clears the 44pt minimum touch target.
        minWidth: 40,
        height: 40,
        alignItems: 'center',
        justifyContent: 'center',
    },
});

export const BackButton = React.memo(BackButtonComponent);
BackButton.displayName = 'BackButton';

export default BackButton;
