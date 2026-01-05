import React, { useState, useRef } from "react";
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
import {
  Left_Arrow,
} from "../../../../assets/svgs";
import { useColorScheme } from "../../../../hooks/use-color-scheme";
import { PrimaryButton } from "@/src/components/buttons/PrimaryButton";
import { useToast } from "@/src/components/toast/ToastProvider";
import { Colors } from '@/constants/theme';
import { FirebaseRecaptchaVerifierModal } from 'expo-firebase-recaptcha';
import { auth, firestore as db } from "../../../../src/services/firebase/initFirebase";
import { PhoneAuthProvider, signInWithCredential } from "firebase/auth";
import { firebaseConfig } from "@/src/firebaseConfig";
import { doc, getDoc, collection, query, where, getDocs, limit } from "firebase/firestore";
import { useSignupStore } from "../../../../src/store/signup";
import { CountryPicker } from "react-native-country-codes-picker";
import { Ionicons } from "@expo/vector-icons";

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
  const [verificationId, setVerificationId] = useState("");
  const [verificationCode, setVerificationCode] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isFocused, setIsFocused] = useState(false);
  const recaptchaVerifier = useRef(null);

  const handleSendOTP = async () => {
    if (!phoneNumber || phoneNumber.length < 8) {
      addToast("Please enter a valid phone number", "error");
      return;
    }

    setIsLoading(true);
    try {
      const fullPhoneNumber = countryCode + phoneNumber;
      const phoneProvider = new PhoneAuthProvider(auth);
      const id = await phoneProvider.verifyPhoneNumber(
        fullPhoneNumber,
        recaptchaVerifier.current!
      );
      setVerificationId(id);
      addToast("OTP sent successfully", "success");
    } catch (error: any) {
      console.error("Phone Auth Error:", error);
      addToast(error.message || "Failed to send OTP", "error");
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
      const credential = PhoneAuthProvider.credential(
        verificationId,
        verificationCode
      );
      
      const userCredential = await signInWithCredential(auth, credential);
      const user = userCredential.user;

      // Normalize phone number for consistent checking
      const fullPhone = user.phoneNumber || (countryCode + phoneNumber);
      const normalizedPhone = fullPhone.replace(/[^\d+]/g, "");

      // 1. Check by UID first (most reliable)
      const userDocRef = doc(db, "users", user.uid);
      const userDocSnap = await getDoc(userDocRef);
      
      let userData = null;
      if (userDocSnap.exists()) {
          userData = userDocSnap.data();
      } else {
          // 2. If not found by UID, check by 'phone' field (for email users who linked phone)
          const q = query(collection(db, "users"), where("phone", "==", normalizedPhone), limit(1));
          const querySnapshot = await getDocs(q);
          if (!querySnapshot.empty) {
              userData = querySnapshot.docs[0].data();
          }
      }

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
      console.error("Verification Error:", error);
      addToast(error.message || "Invalid verification code", "error");
    } finally {
      setIsLoading(false);
    }
  };

  const handleBack = () => {
    if (verificationId) {
      setVerificationId("");
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
            <TouchableOpacity 
              onPress={handleBack} 
              style={styles.backButton}
              hitSlop={{ top: 20, bottom: 20, left: 20, right: 20 }}
            >
              <Left_Arrow width={24} height={24} color={textColor} />
            </TouchableOpacity>
          </View>

          <View style={styles.contentContainer}>
            <Text style={[styles.title, { color: textColor, fontFamily: 'Urbanist-Bold' }]}>
              {verificationId ? "Verify OTP" : "Phone Login"}
            </Text>
            
            <Text style={[styles.subtitle, { color: isDark ? '#E0E0E0' : 'gray', fontFamily: 'Urbanist-Regular' }]}>
              {verificationId 
                ? `Enter the 6-digit code sent to ${countryCode} ${phoneNumber}` 
                : "Enter your phone number to continue"}
            </Text>

            {!verificationId ? (
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
                title={verificationId ? "Verify OTP" : "Send OTP"}
                onPress={verificationId ? handleVerifyOTP : handleSendOTP}
                isLoading={isLoading}
              />
            </View>

            {verificationId && (
              <TouchableOpacity 
                onPress={() => setVerificationId("")}
                style={styles.resendButton}
              >
                <Text style={styles.resendText}>Change Phone Number</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>
      </ScrollView>

      <CountryPicker
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

      <FirebaseRecaptchaVerifierModal
        ref={recaptchaVerifier}
        firebaseConfig={firebaseConfig}
        attemptInvisibleVerification={true}
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
    outlineStyle: 'none',
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
