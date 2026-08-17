/**
 * Ambient module shims for third-party packages that ship no (or broken) type
 * declarations. Typed as `any` so imports resolve without pulling the package's
 * untyped/React-19-incompatible source into our type-check.
 */
declare module 'react-native-razorpay';
declare module 'expo-facebook';
