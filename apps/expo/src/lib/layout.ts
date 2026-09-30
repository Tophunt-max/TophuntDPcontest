import { Platform, useWindowDimensions, type ViewStyle } from 'react-native';

/**
 * Layout width for art that is sized as a fraction of the screen.
 *
 * THE PROBLEM THIS SOLVES
 * ----------------------
 * Screens size their illustrations off the window WIDTH — the login art is
 * `width * 0.6` wide by `width * 0.4` tall. On a phone that is right: 400px of
 * window gives a 240x160 illustration.
 *
 * On a desktop browser it is not. 1280px of window gives 768x512, and a 512px
 * tall illustration is what pushed /auth/login's content to 1015px — taller than
 * the browser's 577px viewport. Combined with `justifyContent: 'center'` and the
 * web build's `body { overflow: hidden }`, that content overflowed symmetrically
 * and 219px was clipped off the top AND the bottom with no way to scroll to it.
 *
 * So the scrolling fix (a ScrollView with `flexGrow: 1`) makes the content
 * REACHABLE, and this makes it the right SIZE — the art stays phone-proportioned
 * instead of growing without limit as the window gets wider.
 *
 * WHY A CAP RATHER THAN A BREAKPOINT
 * ---------------------------------
 * These are phone layouts being shown in a desktop browser. A cap keeps them
 * looking deliberate at any width without needing a second, desktop-specific
 * design for every screen. 420 is a little above the widest common phone
 * (430pt, iPhone Pro Max), so no phone is affected by it at all — this only ever
 * changes what a wide window does.
 *
 * PAIR THIS WITH `useWindowDimensions()`, NOT `Dimensions.get()`
 * ------------------------------------------------------------
 * `Dimensions.get('window')` read at module scope — which is what these screens
 * did — is captured once when the bundle loads and never updates. On a phone that
 * is invisible; on desktop it means resizing the window (or rotating a tablet)
 * leaves the layout sized for the window the user first arrived with.
 * `useWindowDimensions()` re-renders on resize, so the clamp below is re-applied.
 */

/** Just above the widest common phone, so phones are never affected. */
export const PHONE_MAX_WIDTH = 420;

/**
 * Clamp a window width to phone proportions.
 *
 * @param windowWidth from `useWindowDimensions().width`
 */
export function designWidth(windowWidth: number): number {
  return Math.min(windowWidth, PHONE_MAX_WIDTH);
}

/**
 * True when the app is drawn inside the centred phone column (see
 * `src/components/layout/PhoneFrame.tsx`): a web window wider than a phone.
 */
export function isPhoneFramed(windowWidth: number): boolean {
  return Platform.OS === 'web' && windowWidth > PHONE_MAX_WIDTH;
}

/**
 * The window size a screen should lay itself out for. Use this instead of
 * `Dimensions.get('window')`.
 *
 * On web the app is drawn inside a column capped at `PHONE_MAX_WIDTH`
 * (PhoneFrame), so the usable width is the column's, not the browser's. A grid
 * that computes `width / 3` from a 1920px window builds 640px tiles and
 * overflows the column. This returns the column width instead.
 *
 * Native is not capped, because native has no frame. Tablets are supported
 * (`supportsTablet`), and capping there would leave a 420pt layout sitting in a
 * 768pt+ screen.
 *
 * Width and height both come from `useWindowDimensions()`, so a resized browser
 * or a rotated device re-renders with the new size.
 */
export function useDesignWindow(): { width: number; height: number } {
  const { width, height } = useWindowDimensions();
  return { width: Platform.OS === 'web' ? designWidth(width) : width, height };
}

/**
 * Keeps a sheet or card rendered inside a `<Modal>` in the phone column on web.
 *
 * A react-native-web Modal is portalled to <body>, outside PhoneFrame, so a
 * bottom sheet inside one spans the whole desktop window. Add this to the
 * sheet's style. It caps the width and centres it, for normal flow and for
 * `position: 'absolute'` sheets (left/right 0 plus auto margins).
 *
 * Empty on native, where the sheet must stay full-width on tablets. On a
 * phone-width browser the cap is wider than the window, so it changes nothing.
 */
export const webPhoneColumn: ViewStyle =
  Platform.OS === 'web'
    ? {
        width: '100%',
        maxWidth: PHONE_MAX_WIDTH,
        alignSelf: 'center',
        left: 0,
        right: 0,
        marginHorizontal: 'auto',
      }
    : {};
