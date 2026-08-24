import React, { useState } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  TextInput,
  Alert,
} from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BackButton } from "@/src/components/ui/BackButton";
import { useColorScheme } from '@/hooks/use-color-scheme';
import { PrimaryButton } from "@/src/components/buttons/PrimaryButton";
import { useToast } from "@/src/components/toast/ToastProvider";
import { Colors } from '@/constants/theme';
import { auth } from "../../../../src/services/firebase/initFirebase";
import { signInWithCustomToken } from "firebase/auth";
import { callApi, readApi } from "../../../../src/services/api";
import { reportError } from "@/src/lib/reportError";
import { useSignupStore } from "../../../../src/store/signup";
import { CountryPicker } from "react-native-country-codes-picker";
import { Ionicons } from "@/src/lib/icons";

export default function PhoneLoginScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  const backgroundColor = isDark ? Colors.dark.background : Colors.light.background;
  const textColor = isDark ? Colors.dark.text : Colors.light.text;
  const { addToast } = useToast();
  const { setMultiple, reset } = useSignupStore();

  const [phoneNumber, setPhoneNumber] = useState("");
  const [countryCode, setCountryCode] = useState("+91");
  const [showCountryPicker, setShowCountryPicker] = useState(false);
  // `codeSent` replaces the old Firebase verificationId: the OTP is issued and
  // verified by our own Worker now, so there is no client-side verification
  // handle to carry around.
  const [codeSent, setCodeSent] = useState(false);
  const [verificationCode, setVerificationCode] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isFocused, setIsFocused] = useState(false);
  const [resendIn, setResendIn] = useState(0);

  /**
   * Request a login code from our backend.
   *
   * This previously used Firebase's client-side phone auth via
   * `expo-firebase-recaptcha` — an unmaintained package that needs
   * `react-native-webview`, which is not a dependency of this app, so the flow
   * could not work on a real device at all. It also bypassed our own OTP rate
   * limiting and DLT-registered SMS gateway.
   */
  const handleSendOTP = async () => {
    const digits = phoneNumber.replace(/\D/g, "");
    if (digits.length < 6) {
      addToast("Please enter a valid phone number", "error");
      return;
    }

    setIsLoading(true);
    try {
      const res: any = await callApi("sendPhoneLoginOtp", { phone: countryCode + digits });
      setCodeSent(true);
      setVerificationCode("");
      setResendIn(Number(res?.cooldownSeconds) || 60);
      addToast("We've sent you a 6-digit code", "success");
    } catch (error: any) {
      // The server distinguishes "couldn't send" from "too many requests"; pass
      // its message through rather than inventing one.
      addToast(error?.message || "Failed to send the code. Please try again.", "error");
    } finally {
      setIsLoading(false);
    }
  };

  const handleVerifyOTP = async () => {
    if (!verificationCode || verificationCode.length < 6) {
      addToast("Please enter a 6-digit verification code", "error");
      return;
    }

    setIsLoading(true);
    try {
      // The Worker verifies the code (single-use, attempt-limited, fixed
      // lifetime) and returns a Firebase custom token, which we exchange for a
      // normal session. The client never sees the OTP secret material.
      const result: any = await callApi("phoneSignIn", {
        phone: countryCode + phoneNumber.replace(/\D/g, ""),
        code: verificationCode,
      });
      if (!result?.customToken) throw new Error("Sign-in failed. Please try again.");

      const userCredential = await signInWithCustomToken(auth, result.customToken);
      const user = userCredential.user;
      const normalizedPhone = String(result.phone || countryCode + phoneNumber).replace(/[^\d+]/g, "");

      // Look up the profile in D1 (via the Worker), keyed by uid.
      const userData: any = await readApi(`/read/users/${user.uid}`).catch(() => null);

      if (userData) {
        // Check if profile is actually complete (has username or flag)
        if (userData.signupCompleted === true || userData.username) {
          addToast("Welcome back!", "success");
          router.replace("/home");
        } else {
          // Found user but profile incomplete
          setMultiple({
            ...userData,
            phone: normalizedPhone,
            authProvider: 'phone'
          });
          addToast("Please complete your profile.", "info");
          router.replace("/auth/signup/fill-profile");
        }
      } else {
        // NEW USER - Absolutely no record found
        console.log("New User detected:", normalizedPhone);
        reset();
        setMultiple({
            phone: normalizedPhone,
            authProvider: 'phone'
        });
        addToast("OTP Verified! Let's create your profile.", "success");
        router.replace("/auth/signup/fill-profile");
      }
    } catch (error: any) {
      // A wrong code is a normal outcome, not a bug — only report the rest.
      const wrongCode =
        error?.code === "functions/invalid-argument" || error?.code === "functions/not-found";
      if (!wrongCode) reportError(error, { flow: "phone-login", step: "verify" });
      addToast(error?.message || "Invalid verification code", "error");
    } finally {
      setIsLoading(false);
    }
  };

  // Tick the resend cooldown down. The server enforces the real cooldown; this
  // just stops the user hammering a button that will be refused.
  React.useEffect(() => {
    if (resendIn <= 0) return;
    const timer = setTimeout(() => setResendIn((v) => v - 1), 1000);
    return () => clearTimeout(timer);
  }, [resendIn]);

  const handleBack = () => {
    if (codeSent) {
      setCodeSent(false);
    } else {
        if (router.canGoBack()) {
            router.back();
        } else {
            router.replace("/auth/login");
        }
    }
  };

  const inputContainerStyle = [
    styles.inputContainer,
    {
      backgroundColor: isFocused ? (isDark ? '#262933' : '#FFEBEE') : (isDark ? '#1F222A' : '#FAFAFA'),
      borderColor: isFocused ? '#FF4D67' : (isDark ? '#35383F' : '#eee'),
      borderWidth: 1,
    }
  ];

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
    >
      <ScrollView
        contentContainerStyle={{ flexGrow: 1 }}
        keyboardShouldPersistTaps="handled"
      >
        <View
          style={[
            styles.container,
            { backgroundColor, paddingTop: insets.top, paddingBottom: insets.bottom },
          ]}
        >
          {/* Header */}
          <View style={styles.header}>
            <BackButton size={24} color={textColor} onPress={handleBack} style={styles.backButton} />
          </View>

          <View style={styles.contentContainer}>
            <Text style={[styles.title, { color: textColor, fontFamily: 'Urbanist-Bold' }]}>
              {codeSent ? "Verify OTP" : "Phone Login"}
            </Text>
            
            <Text style={[styles.subtitle, { color: isDark ? '#E0E0E0' : 'gray', fontFamily: 'Urbanist-Regular' }]}>
              {codeSent
                ? `Enter the 6-digit code sent to ${countryCode} ${phoneNumber}`
                : "Enter your phone number to continue"}
            </Text>

            {!codeSent ? (
              <View style={styles.phoneInputRow}>
                <TouchableOpacity
                  style={[styles.flagButton, { backgroundColor: isDark ? '#1F222A' : '#FAFAFA', borderColor: isDark ? '#35383F' : '#eee' }]}
                  onPress={() => setShowCountryPicker(true)}
                >
                  <Text style={[styles.flagText, { color: textColor }]}>{countryCode}</Text>
                  <Ionicons name="chevron-down" size={12} color={isDark ? '#fff' : '#9E9E9E'} style={{ marginLeft: 4 }} />
                </TouchableOpacity>

                <View style={[inputContainerStyle, { flex: 1 }]}>
                  <TextInput
                    style={[styles.input, { color: textColor, fontFamily: 'Urbanist-Medium' }]}
                    placeholder="Phone Number"
                    placeholderTextColor={isDark ? '#888' : '#999'}
                    keyboardType="phone-pad"
                    value={phoneNumber}
                    onChangeText={setPhoneNumber}
                    onFocus={() => setIsFocused(true)}
                    onBlur={() => setIsFocused(false)}
                    underlineColorAndroid="transparent"
                  />
                </View>
              </View>
            ) : (
              <View style={inputContainerStyle}>
                <TextInput
                  style={[styles.input, { color: textColor, textAlign: 'center', fontSize: 24, letterSpacing: 8, fontFamily: 'Urbanist-Bold' }]}
                  placeholder="000000"
                  placeholderTextColor={isDark ? '#444' : '#ccc'}
                  keyboardType="number-pad"
                  maxLength={6}
                  value={verificationCode}
                  onChangeText={setVerificationCode}
                  autoFocus
                  onFocus={() => setIsFocused(true)}
                  onBlur={() => setIsFocused(false)}
                  underlineColorAndroid="transparent"
                />
              </View>
            )}

            <View style={{ marginTop: 24 }}>
              <PrimaryButton
                title={codeSent ? "Verify OTP" : "Send OTP"}
                onPress={codeSent ? handleVerifyOTP : handleSendOTP}
                isLoading={isLoading}
              />
            </View>

            {codeSent && (
              <>
                <TouchableOpacity
                  onPress={handleSendOTP}
                  disabled={resendIn > 0 || isLoading}
                  style={styles.resendButton}
                  accessibilityRole="button"
                  accessibilityLabel={resendIn > 0 ? `Resend code in ${resendIn} seconds` : "Resend code"}
                >
                  <Text style={[styles.resendText, resendIn > 0 && { opacity: 0.5 }]}>
                    {resendIn > 0 ? `Resend code in ${resendIn}s` : "Resend code"}
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() => setCodeSent(false)}
                  style={styles.resendButton}
                  accessibilityRole="button"
                  accessibilityLabel="Change phone number"
                >
                  <Text style={[styles.resendText, { color: isDark ? '#9BA1A6' : '#6B7280' }]}>
                    Change Phone Number
                  </Text>
                </TouchableOpacity>
              </>
            )}
          </View>
        </View>
      </ScrollView>

      <CountryPicker
        lang="en"
        show={showCountryPicker}
        pickerButtonOnPress={(item) => {
          setCountryCode(item.dial_code);
          setShowCountryPicker(false);
        }}
        onBackdropPress={() => setShowCountryPicker(false)}
        style={{
          modal: { height: 500, backgroundColor: isDark ? '#1F222A' : '#fff' },
          countryButtonStyles: { backgroundColor: isDark ? '#1F222A' : '#fff', height: 50 },
          textInput: { color: textColor },
          dialCode: { color: textColor },
          countryName: { color: textColor }
        }}
      />

    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    paddingHorizontal: 24,
    paddingVertical: 10,
    zIndex: 10,
  },
  backButton: {
    width: 40,
    height: 40,
    justifyContent: "center",
    alignItems: "flex-start",
  },
  contentContainer: {
    flex: 1,
    paddingHorizontal: 24,
    paddingTop: 20,
  },
  title: {
    fontSize: 32,
    marginBottom: 12,
  },
  subtitle: {
    fontSize: 16,
    marginBottom: 32,
    lineHeight: 24,
  },
  phoneInputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  flagButton: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 16,
    paddingHorizontal: 12,
    height: 56,
    borderWidth: 1,
    justifyContent: 'center',
  },
  flagText: {
    fontSize: 16,
    fontFamily: "Urbanist-Medium",
  },
  inputContainer: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 16,
    paddingHorizontal: 16,
    paddingVertical: 12,
    minHeight: 56,
  },
  input: {
    flex: 1,
    fontSize: 16,
    outlineStyle: 'none' as any,
  },
  resendButton: {
    alignItems: "center",
    marginTop: 24,
  },
  resendText: {
    color: "#FF4D67",
    fontSize: 16,
    fontWeight: "600",
  },
});
