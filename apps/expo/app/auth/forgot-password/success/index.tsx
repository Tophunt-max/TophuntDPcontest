
import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useThemeColor } from "@/hooks/use-theme-color";
import { PrimaryButton } from "@/src/components/buttons/PrimaryButton";
import { Success } from "@/assets/svgs";

export default function SuccessScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const backgroundColor = useThemeColor({}, "background");
  const textColor = useThemeColor({}, "text");

  return (
    <View
      style={[
        styles.container,
        {
          backgroundColor,
          paddingTop: insets.top,
          paddingBottom: insets.bottom,
        },
      ]}
    >
      <View style={styles.content}>
        <Success />
        <Text style={[styles.title, { color: textColor }]}>Check your email</Text>
        <Text style={[styles.subtitle, { color: textColor }]}>
          If that address has a password account, a reset link is on its way — check
          your spam folder too. Nothing arriving? You may have signed up with
          Google, Apple or your phone number; sign in with that method instead.
        </Text>
      </View>
      <PrimaryButton
        title="Back to Login"
        onPress={() => router.replace("/auth/login")}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 24,
    justifyContent: "center",
  },
  content: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  title: {
    fontSize: 24,
    fontFamily: "Urbanist-Bold",
    marginTop: 24,
    textAlign: "center",
  },
  subtitle: {
    fontSize: 16,
    fontFamily: "Urbanist-Medium",
    marginTop: 12,
    textAlign: "center",
    lineHeight: 24,
    opacity: 0.7,
  },
});
