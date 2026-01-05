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
import { useColorScheme } from "@/hooks/use-color-scheme";
import { Left_Arrow, ForgotPassword_Light, ForgotPassword_Dark, Sms_Icon, Email_Icon } from "@/assets/svgs";
import { PrimaryButton } from "@/src/components/buttons/PrimaryButton";
import { useToast } from "@/src/components/toast/ToastProvider";
import { sendPasswordResetEmail } from "firebase/auth";
import { auth, functions } from "@/src/services/firebase/initFirebase";
import { httpsCallable } from 'firebase/functions';
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

  // This function is triggered when user presses continue
  // It first checks if user exists in DB, then sends the reset link/OTP
  const handleContinue = async (data: any) => {
    setLoading(true);
    setUserInfo(null); 
    clearErrors(); // Clear any previous manual errors

    const identifier = activeTab === "email" ? data.email : data.phoneNumber;
    const fieldName = activeTab === "email" ? "email" : "phoneNumber";

    // Basic validation just in case
    if (!identifier) {
        setError(fieldName, { type: 'required', message: 'This field is required' });
        setLoading(false);
        return;
    }
    
    try {
        // 1. Check if user exists and get info
        const getUser = httpsCallable(functions, 'getUserByIdentifier');
        const result: any = await getUser({ 
            identifier: identifier, 
            type: activeTab === 'email' ? 'email' : 'phone' 
        });

        if (!result.data.found) {
            // Client-side error on the specific input field
            setError(fieldName, { 
                type: "manual", 
                message: "User not found. Please check your details." 
            });
            setLoading(false);
            return;
        }

        // User found! Show their info briefly or proceed
        const user = result.data.user;
        setUserInfo(user);
        // addToast(`Found account for ${user.name}`, "success");

        // 2. Proceed with Sending Link/OTP
        if (activeTab === "email") {
            await sendPasswordResetEmail(auth, data.email);
            addToast("Password reset link sent to your email", "success");
            // Navigate to success screen
            router.push("/auth/forgot-password/success");
        } else {
            const sendOtp = httpsCallable(functions, 'sendOtpToPhone');
            await sendOtp({ phone: data.phoneNumber });
            // Navigate to OTP screen
            router.push({
                pathname: "/auth/forgot-password/otp",
                params: { phoneNumber: data.phoneNumber },
            });
        }

    } catch (error: any) {
        console.error("Forgot Password Error:", error);
        // If specific error codes, map them to fields, otherwise general toast
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
        {/* Header */}
        <View style={styles.header}>
            <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
              <Left_Arrow width={24} height={24} color="#000" />
            </TouchableOpacity>
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

        {/* Custom Tab Switcher */}
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

        {/* Input Content */}
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