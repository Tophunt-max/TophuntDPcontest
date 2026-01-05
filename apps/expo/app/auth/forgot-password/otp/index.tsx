import React, { useState, useEffect, useRef } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Platform,
  KeyboardAvoidingView,
  TextInput,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useThemeColor } from "@/hooks/use-theme-color";
import { Left_Arrow } from "@/assets/svgs";
import { PrimaryButton } from "@/src/components/buttons/PrimaryButton";
import { useToast } from "@/src/components/toast/ToastProvider";
import { httpsCallable } from 'firebase/functions';
import { functions } from "@/src/services/firebase/initFirebase";

const RESEND_TIME = 60;

export default function OtpVerificationScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { phoneNumber } = useLocalSearchParams<{ phoneNumber: string }>();
  const backgroundColor = useThemeColor({}, "background");
  const textColor = useThemeColor({}, "text");
  const { addToast } = useToast();

  const [otp, setOtp] = useState<string[]>(Array(4).fill(""));
  const [timer, setTimer] = useState(RESEND_TIME);
  const [loading, setLoading] = useState(false);
  const [resending, setResending] = useState(false);
  const inputRefs = useRef<Array<TextInput | null>>([]);

  useEffect(() => {
    const interval = setInterval(() => {
      setTimer((prev) => (prev > 0 ? prev - 1 : 0));
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  const handleOtpChange = (text: string, index: number) => {
    const newOtp = [...otp];
    newOtp[index] = text;
    setOtp(newOtp);

    if (text && index < 3) {
      inputRefs.current[index + 1]?.focus();
    }
  };

  const handleVerify = async () => {
    const code = otp.join("");
    if (code.length !== 4) {
      addToast({ type: "error", text: "Please enter a valid 4-digit OTP." });
      return;
    }
    setLoading(true);
    try {
      const verifyOtp = httpsCallable(functions, 'verifyOtp');
      await verifyOtp({ phone: phoneNumber, code });
      router.push({
        pathname: "/auth/forgot-password/reset",
        params: { phoneNumber },
      });
    } catch (error: any) {
      addToast({ type: "error", text: error.message });
    } finally {
      setLoading(false);
    }
  };

  const handleResend = async () => {
    if (timer > 0) return;
    setResending(true);
    try {
      const resendOtp = httpsCallable(functions, 'resendOtp');
      await resendOtp({ phone: phoneNumber });
      setTimer(RESEND_TIME);
      addToast({ type: "success", text: "OTP has been resent." });
    } catch (error: any) {
      addToast({ type: "error", text: error.message });
    } finally {
      setResending(false);
    }
  };
  
  const formattedPhoneNumber = `+${phoneNumber?.substring(0, 2)}******${phoneNumber?.substring(phoneNumber.length - 2)}`;

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      style={{ flex: 1, backgroundColor }}
    >
      <ScrollView
        contentContainerStyle={{
          flexGrow: 1,
          paddingTop: insets.top,
          paddingBottom: insets.bottom,
        }}
      >
        <View style={styles.container}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
            <Left_Arrow />
          </TouchableOpacity>
          <View style={styles.header}>
            <Text style={[styles.title, { color: textColor }]}>Forgot Password</Text>
            <Text style={[styles.subtitle, { color: textColor }]}>
              Code has been sent to {formattedPhoneNumber}
            </Text>
          </View>

          <View style={styles.otpContainer}>
            {otp.map((digit, index) => (
              <TextInput
                key={index}
                ref={(ref) => (inputRefs.current[index] = ref)}
                style={[
                  styles.otpInput,
                  {
                    color: textColor,
                    backgroundColor: useThemeColor({}, "input"),
                    borderColor: useThemeColor({}, "inputBorder"),
                  },
                ]}
                keyboardType="number-pad"
                maxLength={1}
                onChangeText={(text) => handleOtpChange(text, index)}
                value={digit}
              />
            ))}
          </View>
          <TouchableOpacity onPress={handleResend} disabled={timer > 0 || resending}>
            <Text style={[styles.resendText, { color: timer > 0 ? "gray" : "#FF6347" }]}>
              Resend in {timer}s
            </Text>
          </TouchableOpacity>

          <PrimaryButton
            title="Verify"
            onPress={handleVerify}
            isLoading={loading}
            disabled={loading || otp.join("").length !== 4}
          />
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 20,
    alignItems: 'center'
  },
  backButton: {
    alignSelf: "flex-start",
    padding: 10,
  },
  header: {
    alignItems: "center",
    marginBottom: 30,
  },
  title: {
    fontSize: 24,
    fontWeight: "bold",
    marginBottom: 20,
  },
  subtitle: {
    fontSize: 16,
    textAlign: "center",
    paddingHorizontal: 20,
  },
  otpContainer: {
    flexDirection: "row",
    justifyContent: "space-between",
    width: "60%",
    marginBottom: 30,
  },
  otpInput: {
    width: 50,
    height: 50,
    textAlign: "center",
    fontSize: 20,
    borderRadius: 10,
    borderWidth: 1,
  },
  resendText: {
    fontSize: 16,
    marginBottom: 30,
  },
});