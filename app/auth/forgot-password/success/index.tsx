
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
        <Text style={[styles.title, { color: textColor }]}>Congratulations!</Text>
        <Text style={[styles.subtitle, { color: textColor }]}>
          Your account is ready to use
        </Text>
      </View>
      <PrimaryButton
        title="Go to Homepage"
        onPress={() => router.replace("/home")}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 20,
    justifyContent: "center",
  },
  content: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  title: {
    fontSize: 24,
    fontWeight: "bold",
    marginTop: 20,
  },
  subtitle: {
    fontSize: 16,
    marginTop: 10,
  },
});
