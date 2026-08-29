
import React, { useCallback, useEffect, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useThemeColor } from "@/hooks/use-theme-color";
import { PrimaryButton } from "@/src/components/buttons/PrimaryButton";
import { useToast } from "@/src/components/toast/ToastProvider";
import { Success } from "@/assets/svgs";
import {
  requestPasswordReset,
  describeNoPasswordAccount,
  RESEND_COOLDOWN_SEC,
} from "@/src/services/auth/passwordReset";

/**
 * Shown only after Firebase has ACCEPTED the reset request.
 *
 * Two things here are the actual remedy for "no email is arriving", and both were
 * missing:
 *
 *  - the address is displayed. A mistyped address is otherwise completely
 *    invisible: the old screen said "check your email" without saying which one,
 *    so a typo looked identical to a delivery failure.
 *  - a resend, rate-limited client-side. The previous flow made a lost or
 *    spam-filtered mail unrecoverable without retyping the address, and each
 *    retry from the start is another chance to mistype it.
 *
 * The wording is definite ("sent to X") because reaching this screen now means
 * Firebase accepted the request. It used to hedge — "if that address has a
 * password account" — while also being reached when Firebase had explicitly said
 * the account did not exist.
 */
export default function SuccessScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const backgroundColor = useThemeColor({}, "background");
  const textColor = useThemeColor({}, "text");
  const { addToast } = useToast();
  const { email } = useLocalSearchParams<{ email?: string }>();

  const [cooldown, setCooldown] = useState(RESEND_COOLDOWN_SEC);
  const [resending, setResending] = useState(false);

  // Start the countdown immediately: a mail that was accepted a second ago has
  // not had time to arrive, so the button must not invite an instant retry.
  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  const onResend = useCallback(async () => {
    if (!email || resending || cooldown > 0) return;
    setResending(true);
    try {
      const outcome = await requestPasswordReset(email);
      if (outcome.status === "no-password-account") {
        // Can happen if the account was deleted between the two attempts.
        addToast(describeNoPasswordAccount(outcome.email, outcome.providers), "error");
        return;
      }
      addToast(`Reset link sent again to ${outcome.email}.`, "success");
      setCooldown(RESEND_COOLDOWN_SEC);
    } catch (e: any) {
      // `requestPasswordReset` already turns rate limiting and network failures
      // into readable text, including the case where Firebase itself starts
      // throttling this address.
      addToast(e?.message || "Could not resend the link.", "error");
    } finally {
      setResending(false);
    }
  }, [email, resending, cooldown, addToast]);

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

        {email ? (
          <>
            <Text style={[styles.subtitle, { color: textColor }]}>
              We sent a password reset link to
            </Text>
            <Text style={[styles.email, { color: textColor }]}>{email}</Text>
            <Text style={[styles.hint, { color: textColor }]}>
              It can take a couple of minutes. If it is not in your inbox, check your
              spam or junk folder — the link comes from noreply@tophuntdpcontest.firebaseapp.com.
            </Text>

            <TouchableOpacity
              onPress={onResend}
              disabled={cooldown > 0 || resending}
              accessibilityRole="button"
              accessibilityLabel="Resend password reset email"
              style={styles.resend}
            >
              {resending ? (
                <ActivityIndicator size="small" color="#ff4466" />
              ) : (
                <Text style={[styles.resendText, { opacity: cooldown > 0 ? 0.5 : 1 }]}>
                  {cooldown > 0 ? `Resend link in ${cooldown}s` : "Resend link"}
                </Text>
              )}
            </TouchableOpacity>
          </>
        ) : (
          // Reached by a direct navigation or deep link, with no address to show
          // or resend to. Say only what is true in that case.
          <Text style={[styles.subtitle, { color: textColor }]}>
            A password reset link has been sent. Check your spam or junk folder too.
          </Text>
        )}
      </View>

      <PrimaryButton title="Back to Login" onPress={() => router.replace("/auth/login")} />
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
  email: {
    fontSize: 17,
    fontFamily: "Urbanist-Bold",
    marginTop: 6,
    textAlign: "center",
  },
  hint: {
    fontSize: 14,
    fontFamily: "Urbanist-Medium",
    marginTop: 14,
    textAlign: "center",
    lineHeight: 21,
    opacity: 0.6,
  },
  resend: {
    marginTop: 22,
    minHeight: 44,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 16,
  },
  resendText: {
    fontSize: 15,
    fontFamily: "Urbanist-Bold",
    color: "#ff4466",
  },
});
