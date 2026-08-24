import React from 'react';
import { View } from 'react-native';

/**
 * Marks its children as a unit that can be screenshotted.
 *
 * That is the whole job, and it is one prop: `collapsable={false}`. Without it
 * Android is free to flatten a view whose only purpose is to wrap others out of
 * the native hierarchy — and a view that does not exist natively cannot be
 * captured, so `captureRef` fails with "findNodeHandle failed to resolve view".
 * It is exactly the kind of prop that looks removable and is not, which is why
 * this is a named component with a comment rather than an inline `<View>`.
 *
 * Deliberately NOT `react-native-view-shot`'s `<ViewShot>`. That component exists
 * for its `captureMode` prop (capture on mount, or continuously) which nothing
 * here wants, and it consumes the `ref` for its own instance — while
 * `captureRef()` takes any plain view ref directly. Using a plain `View` also
 * means this file imports nothing native, so it is identical on every platform
 * and there is no conditional branch to get wrong.
 */

type Props = {
  innerRef: React.MutableRefObject<any>;
  children: React.ReactNode;
};

export const VsCaptureBoundary: React.FC<Props> = ({ innerRef, children }) => (
  <View ref={innerRef} collapsable={false}>
    {children}
  </View>
);

export default VsCaptureBoundary;
