import React, { useCallback, useEffect, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useThemeColor } from "@/hooks/use-theme-color";
import { useColorScheme } from "@/hooks/use-color-scheme";
import { PrimaryButton } from "@/src/components/buttons/PrimaryButton";
import { useToast } from "@/src/components/toast/ToastProvider";
import { Eye_Open, Eye_Close } from "@/assets/svgs";
import {
  parseMode,
  verifyResetCode,
  completePasswordReset,
  applyEmailActionCode,
  messageForActionError,
} from "@/src/services/auth/actionLink";
import { validatePassword, passwordRequirements } from "@/src/lib/passwordPolicy";

const ACCENT = "#ff4466";

/**
 * Handler for Firebase email action links (`?mode=…&oobCode=…`).
 *
 * The reset email's link used to land on the WELCOME/LOGIN screen with no way to
 * set a password. Firebase's template action URL points at `tophunt.in`, and once
 * that URL is customised Firebase stops handling the link itself — it forwards
 * the browser with `mode` and `oobCode` in the query and expects the app to
 * finish the job. Nothing in the app did (`oobCode` appeared nowhere in the
 * codebase), so the route matched nothing and fell through to login. The email
 * arrived and the link opened; the reset was still impossible.
 *
 * `/__/auth/action` — the path Firebase actually sends — is redirected here by
 * public/_worker.js, because a path segment beginning with `__` cannot be
 * expressed as an expo-router file route.
 *
 * The code is verified BEFORE the form renders. An expired or already-used link
 * then says so at once, instead of after the user has carefully typed a new
 * password into two fields.
 */
export default function AuthActionScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const isDark = useColorScheme() === "dark";
  const backgroundColor = useThemeColor({}, "background");
  const textColor = useThemeColor({}, "text");
  const { addToast } = useToast();

  const params = useLocalSearchParams<{ mode?: string; oobCode?: string }>();
  const mode = parseMode(params.mode);
  const oobCode = typeof params.oobCode === "string" ? params.oobCode : "";

  const [checking, setChecking] = useState(true);
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const subText = isDark ? "#9B9BA3" : "#6A6A73";
  const fieldBg = isDark ? "#151517" : "#FAFAFA";
  const borderColor = isDark ? "#232327" : "#EEEEEE";

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!oobCode) {
        setFatalError(
          "This link is incomplete. Open the most recent password reset email and tap the link there again.",
        );
        setChecking(false);
        return;
      }
      try {
        if (mode === "resetPassword") {
          const { email: addr } = await verifyResetCode(oobCode);
          if (!cancelled) setEmail(addr);
        } else if (mode === "verifyEmail" || mode === "recoverEmail") {
          const { email: addr } = await applyEmailActionCode(oobCode);
          if (!cancelled) {
            setEmail(addr);
            setDone(true);
          }
        } else {
          if (!cancelled) setFatalError("This link is not something the app can handle.");
        }
      } catch (e: any) {
        if (!cancelled) setFatalError(messageForActionError(e?.code));
      } finally {
        if (!cancelled) setChecking(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mode, oobCode]);

  const onSubmit = useCallback(async () => {
    if (submitting) return;
    // Our policy, not Firebase's: confirmPasswordReset only enforces a
    // 6-character minimum, which is looser than what signup requires, so
    // without this a reset could set a password our own signup would refuse.
    const policyError = validatePassword(password);
    if (policyError) {
      setFormError(policyError);
      return;
    }
    if (password !== confirm) {
      setFormError("Both passwords must match.");
      return;
    }
    setFormError(null);
    setSubmitting(true);
    try {
      await completePasswordReset(oobCode, password);
      setDone(true);
      addToast("Password updated. Sign in with your new password.", "success");
    } catch (e: any) {
      // The code is single-use, so a failure here is usually terminal rather
      // than something to retry with the same link.
      setFatalError(messageForActionError(e?.code));
    } finally {
      setSubmitting(false);
    }
  }, [password, confirm, oobCode, submitting, addToast]);

  const goToLogin = () => router.replace("/auth/login/password");

  const body = () => {
    if (checking) {
      return (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={ACCENT} />
          <Text style={[styles.hint, { color: subText }]}>Checking your link…</Text>
        </View>
      );
    }

    if (fatalError) {
      return (
        <View style={styles.center}>
          <Text style={[styles.title, { color: textColor }]}>Link cannot be used</Text>
          <Text style={[styles.body, { color: subText }]}>{fatalError}</Text>
          <View style={{ height: 24 }} />
          <PrimaryButton
            title="Request a new link"
            onPress={() => router.replace("/auth/forgot-password")}
          />
          <TouchableOpacity onPress={goToLogin} style={styles.secondary} accessibilityRole="button">
            <Text style={[styles.secondaryText, { color: subText }]}>Back to login</Text>
          </TouchableOpacity>
        </View>
      );
    }

    if (done) {
      return (
        <View style={styles.center}>
          <Text style={[styles.title, { color: textColor }]}>
            {mode === "resetPassword" ? "Password updated" : "Email confirmed"}
          </Text>
          <Text style={[styles.body, { color: subText }]}>
            {mode === "resetPassword"
              ? `You can now sign in${email ? ` as ${email}` : ""} with your new password.`
              : `${email ? `${email} is` : "Your email is"} confirmed.`}
          </Text>
          <View style={{ height: 24 }} />
          <PrimaryButton title="Sign in" onPress={goToLogin} />
        </View>
      );
    }

    // resetPassword, code verified
    const reqs = passwordRequirements(password);
    return (
      <View style={{ flex: 1 }}>
        <Text style={[styles.title, { color: textColor, textAlign: "left" }]}>Set a new password</Text>
        {email ? (
          <Text style={[styles.body, { color: subText, textAlign: "left" }]}>
            for <Text style={{ fontFamily: "Urbanist-Bold", color: textColor }}>{email}</Text>
          </Text>
        ) : null}

        <View style={[styles.field, { backgroundColor: fieldBg, borderColor }]}>
          <TextInput
            value={password}
            onChangeText={(t) => {
              setPassword(t);
              setFormError(null);
            }}
            placeholder="New password"
            placeholderTextColor={subText}
            secureTextEntry={!showPassword}
            autoCapitalize="none"
            autoComplete="new-password"
            accessibilityLabel="New password"
            style={[
              styles.input,
              { color: textColor },
              Platform.OS === "web" ? ({ outlineStyle: "none" } as any) : null,
            ]}
          />
          <TouchableOpacity
            onPress={() => setShowPassword((s) => !s)}
            accessibilityRole="button"
            accessibilityLabel={showPassword ? "Hide password" : "Show password"}
            hitSlop={8}
          >
            {showPassword ? (
              <Eye_Open width={22} height={22} color={subText} />
            ) : (
              <Eye_Close width={22} height={22} color={subText} />
            )}
          </TouchableOpacity>
        </View>

        <View style={[styles.field, { backgroundColor: fieldBg, borderColor }]}>
          <TextInput
            value={confirm}
            onChangeText={(t) => {
              setConfirm(t);
              setFormError(null);
            }}
            placeholder="Confirm new password"
            placeholderTextColor={subText}
            secureTextEntry={!showPassword}
            autoCapitalize="none"
            autoComplete="new-password"
            accessibilityLabel="Confirm new password"
            style={[
              styles.input,
              { color: textColor },
              Platform.OS === "web" ? ({ outlineStyle: "none" } as any) : null,
            ]}
          />
        </View>

        {/* Live checklist, driven by the same predicates as the validator, so it
            cannot show all-green on a password that would then be rejected. */}
        <View style={styles.reqs}>
          {reqs.map((r) => (
            <Text
              key={r.label}
              style={[styles.reqText, { color: r.met ? "#2BB673" : subText }]}
            >
              {r.met ? "\u2713" : "\u2022"}  {r.label}
            </Text>
          ))}
        </View>

        {formError ? <Text style={styles.error}>{formError}</Text> : null}

        <View style={{ marginTop: "auto", paddingTop: 20 }}>
          <PrimaryButton
            title="Save new password"
            onPress={onSubmit}
            isLoading={submitting}
            disabled={submitting || !password || !confirm}
          />
        </View>
      </View>
    );
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      style={{ flex: 1, backgroundColor }}
    >
      <ScrollView
        contentContainerStyle={{
          flexGrow: 1,
          paddingTop: insets.top + 24,
          paddingBottom: insets.bottom + 24,
          paddingHorizontal: 24,
        }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {body()}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  title: {
    fontSize: 24,
    fontFamily: "Urbanist-Bold",
    textAlign: "center",
    marginBottom: 10,
  },
  body: {
    fontSize: 15.5,
    fontFamily: "Urbanist-Medium",
    textAlign: "center",
    lineHeight: 23,
    marginBottom: 4,
  },
  hint: { marginTop: 14, fontSize: 15, fontFamily: "Urbanist-Medium" },
  field: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 16,
    height: 56,
    marginTop: 16,
  },
  input: { flex: 1, fontSize: 15.5, fontFamily: "Urbanist-Medium" },
  reqs: { marginTop: 18, gap: 6 },
  reqText: { fontSize: 13.5, fontFamily: "Urbanist-Medium" },
  error: {
    marginTop: 16,
    color: ACCENT,
    fontSize: 14,
    fontFamily: "Urbanist-SemiBold",
  },
  secondary: { marginTop: 18, minHeight: 44, justifyContent: "center" },
  secondaryText: { fontSize: 15, fontFamily: "Urbanist-SemiBold" },
});
