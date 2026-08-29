import React, { useState } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Platform,
  KeyboardAvoidingView,
  TextInput,
  Image,
} from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useThemeColor } from "@/hooks/use-theme-color";
import { useColorScheme } from '@/hooks/use-color-scheme';
import { ForgotPassword_Light, ForgotPassword_Dark, Sms_Icon, Email_Icon } from "@/assets/svgs";
import { BackButton } from "@/src/components/ui/BackButton";
import { PrimaryButton } from "@/src/components/buttons/PrimaryButton";
import { useToast } from "@/src/components/toast/ToastProvider";
import { requestPasswordReset, describeNoPasswordAccount } from "@/src/services/auth/passwordReset";
import { callApi } from '@/src/services/api'; // Consolidated API used
import { FormInput } from "@/src/components/inputs/FormInput";
import { useForm } from "react-hook-form";

export default function ForgotPasswordScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const colorScheme = useColorScheme();
  const backgroundColor = useThemeColor({}, "background");
  const textColor = useThemeColor({}, "text");
  const { addToast } = useToast();

  const [activeTab, setActiveTab] = useState<"email" | "sms">("email");
  const [loading, setLoading] = useState(false);
  const [userInfo, setUserInfo] = useState<{name: string, avatar: string | null} | null>(null);

  const { control, handleSubmit, watch, setError, clearErrors } = useForm({
    defaultValues: {
      email: "",
      phoneNumber: "",
    }
  });

  const email = watch("email");
  const phoneNumber = watch("phoneNumber");

  const handleContinue = async (data: any) => {
    setLoading(true);
    setUserInfo(null);
    clearErrors();

    const identifier = activeTab === "email" ? data.email : data.phoneNumber;
    const fieldName = activeTab === "email" ? "email" : "phoneNumber";

    if (!identifier) {
        setError(fieldName, { type: 'required', message: 'This field is required' });
        setLoading(false);
        return;
    }

    // The PHONE channel still hides existence, because the Worker genuinely does
    // not tell us: it only sends an SMS for a registered number but always
    // returns success, so there is nothing to report either way.
    //
    // The EMAIL channel no longer hides it. Firebase Email Enumeration Protection
    // is off on this project, so anyone can enumerate accounts directly with the
    // API key that ships in the bundle — the silence protected nothing, while
    // costing every user who mistyped their address or signed up with Google the
    // ability to find out why no mail arrived. See services/auth/passwordReset.ts
    // for the evidence and for how this stays correct if protection is enabled.
    try {
        if (activeTab === "email") {
            const outcome = await requestPasswordReset(data.email);
            if (outcome.status === "no-password-account") {
                // Keep the user on this screen: the fix is to change what they
                // typed or to use a different sign-in method, and both happen
                // here. Sending them to a "check your email" screen would be the
                // original bug.
                const message = describeNoPasswordAccount(outcome.email, outcome.providers);
                setError("email", { type: "manual", message });
                addToast(message, "error");
                return;
            }
            // Firebase accepted it, so this is now a statement of fact rather
            // than a hedge. The address is carried through so the confirmation
            // screen can show it — a typo is invisible otherwise — and so a
            // resend does not need it retyped.
            addToast(`Reset link sent to ${outcome.email}.`, "success");
            router.push({
                pathname: "/auth/forgot-password/success",
                params: { email: outcome.email },
            });
        } else {
            await callApi('sendOtpToPhone', { phone: data.phoneNumber });
            router.push({
                pathname: "/auth/forgot-password/otp",
                params: { phoneNumber: data.phoneNumber },
            });
        }
    } catch (error: any) {
        console.error("Forgot Password Error:", error);
        addToast(error.message || "An error occurred", "error");
    } finally {
        setLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      style={{ flex: 1, backgroundColor: "#fff" }}
    >
      <ScrollView
        contentContainerStyle={{
          flexGrow: 1,
          paddingTop: insets.top,
          paddingBottom: insets.bottom,
          paddingHorizontal: 24,
        }}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.header}>
            <BackButton size={24} color={textColor} style={styles.backButton} />
            <Text style={styles.headerTitle}>Forgot Password</Text>
            <View style={{ width: 24 }} />
        </View>

        <View style={styles.illustrationContainer}>
             {colorScheme === "light" ? (
                <ForgotPassword_Light width={250} height={200} />
             ) : (
                <ForgotPassword_Dark width={250} height={200} />
             )}
        </View>
        
        <Text style={styles.instructionText}>
            Select which contact details should we use to reset your password
        </Text>

        <View style={styles.tabContainer}>
            <TouchableOpacity 
                style={[styles.tabButton, activeTab === "email" && styles.activeTabButton]} 
                onPress={() => { setActiveTab("email"); setUserInfo(null); clearErrors(); }}
            >
                <Text style={[styles.tabText, activeTab === "email" && styles.activeTabText]}>Email</Text>
            </TouchableOpacity>
            <TouchableOpacity 
                style={[styles.tabButton, activeTab === "sms" && styles.activeTabButton]} 
                onPress={() => { setActiveTab("sms"); setUserInfo(null); clearErrors(); }}
            >
                <Text style={[styles.tabText, activeTab === "sms" && styles.activeTabText]}>SMS</Text>
            </TouchableOpacity>
        </View>

        <View style={styles.inputContainer}>
            {activeTab === "email" ? (
                <FormInput
                    control={control}
                    name="email"
                    placeholder="Enter your email"
                    icon={<Email_Icon width={20} height={20} color={activeTab === 'email' ? '#ff4466' : '#9E9E9E'} />}
                    keyboardType="email-address"
                    autoCapitalize="none"
                />
            ) : (
                <FormInput
                    control={control}
                    name="phoneNumber"
                    placeholder="Enter your phone number"
                    icon={<Sms_Icon width={20} height={20} color={activeTab === 'sms' ? '#ff4466' : '#9E9E9E'} />}
                    keyboardType="phone-pad"
                />
            )}
        </View>

        <View style={styles.footer}>
             <PrimaryButton
                title="Continue"
                onPress={handleSubmit(handleContinue)}
                isLoading={loading}
                disabled={loading || (activeTab === 'email' ? !email : !phoneNumber)}
                style={styles.continueButton}
            />
        </View>

      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 10,
    marginBottom: 20,
  },
  backButton: {
    padding: 8,
    marginLeft: -8,
  },
  headerTitle: {
      fontSize: 24,
      fontFamily: "Urbanist-Bold",
      color: "#000",
  },
  illustrationContainer: {
    alignItems: "center",
    marginBottom: 30,
  },
  instructionText: {
    fontSize: 16,
    fontFamily: "Urbanist-Medium",
    color: "#000",
    marginBottom: 24,
  },
  tabContainer: {
      flexDirection: 'row',
      backgroundColor: '#FAFAFA', 
      borderRadius: 30, 
      padding: 4,
      marginBottom: 30,
      borderWidth: 1,
      borderColor: '#EEEEEE',
  },
  tabButton: {
      flex: 1,
      paddingVertical: 12,
      alignItems: 'center',
      borderRadius: 25,
  },
  activeTabButton: {
      backgroundColor: '#fff', 
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.1,
      shadowRadius: 4,
      elevation: 2,
  },
  tabText: {
      fontSize: 16,
      fontFamily: 'Urbanist-SemiBold',
      color: '#9E9E9E',
  },
  activeTabText: {
      color: '#ff4466', 
  },
  inputContainer: {
      marginBottom: 30,
  },
  footer: {
      marginTop: 'auto',
      marginBottom: 20,
  },
  continueButton: {
      borderRadius: 30,
      paddingVertical: 18,
  }
});