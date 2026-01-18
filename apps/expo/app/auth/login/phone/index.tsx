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
import { doc, getDoc, collection, query, where, getDocs, setDoc, serverTimestamp } from "firebase/firestore";
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
  const recaptchaVerifier = useRef<any>(null);

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

      // 1. Normalize Phone Number for searching (EXTREME FLEXIBILITY)
      const fullPhone = user.phoneNumber || (countryCode + phoneNumber);
      const cleanedPhone = fullPhone.replace(/[^\d+]/g, ''); 
      const last10Digits = cleanedPhone.slice(-10);
      
      // Variations: [+91987..., 91987..., 987...]
      const searchVariations = [cleanedPhone, last10Digits];
      if (cleanedPhone.startsWith('+')) {
          searchVariations.push(cleanedPhone.substring(1));
      }
      
      console.log("[Auth] Searching for profile with variations:", searchVariations);

      let existingData: any = null;
      let existingDocId: string | null = null;

      // 2. SEARCH LOGIC: Check by phone variations (Fixes Duplicate Account Bug)
      const usersRef = collection(db, "users");
      const q = query(usersRef, where("phone", "in", searchVariations));
      const querySnapshot = await getDocs(q);

      if (!querySnapshot.empty) {
        existingData = querySnapshot.docs[0].data();
        existingDocId = querySnapshot.docs[0].id;
        console.log("[Auth] Found existing user ID:", existingDocId);
      }

      // 3. DECISION LOGIC
      if (existingData && (existingData.signupCompleted === true || existingData.username)) {
        
        // --- DATA MIGRATION CHECK ---
        if (existingDocId !== user.uid) {
            console.log("[Migration] Copying data to new session UID:", user.uid);
            const newDocRef = doc(db, "users", user.uid);
            await setDoc(newDocRef, {
                ...existingData,
                uid: user.uid,
                updatedAt: serverTimestamp(),
                signupCompleted: true,
                migratedFrom: existingDocId
            }, { merge: true });
        }

        addToast("Welcome back!", "success");
        router.replace("/home");

      } else {
        // NEW USER OR INCOMPLETE PROFILE
        console.log("[Auth] No complete profile. Redirecting to Fill Profile.");
        reset(); 
        setMultiple({
            uid: user.uid,
            phone: cleanedPhone,
            authProvider: 'phone',
            ...(existingData || {}) 
        });
        addToast("OTP Verified! Please complete your profile.", "success");
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
            <TouchableOpacity onPress={handleBack} style={styles.backButton}>
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

                <View style={[styles.inputContainer, { flex: 1, backgroundColor: isFocused ? (isDark ? '#262933' : '#FFEBEE') : (isDark ? '#1F222A' : '#FAFAFA'), borderColor: isFocused ? '#FF4D67' : (isDark ? '#35383F' : '#eee'), borderWidth: 1 }]}>
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
              <View style={[styles.inputContainer, { backgroundColor: isFocused ? (isDark ? '#262933' : '#FFEBEE') : (isDark ? '#1F222A' : '#FAFAFA'), borderColor: isFocused ? '#FF4D67' : (isDark ? '#35383F' : '#eee'), borderWidth: 1 }]}>
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
              <TouchableOpacity onPress={() => setVerificationId("")} style={styles.resendButton}>
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
