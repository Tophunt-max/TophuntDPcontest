import React, { useState, useEffect } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  Image,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  Alert,
  TextInput,
  Dimensions,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { useRouter } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import { useAuth } from "@/src/hooks/useAuth";
import { useProfile } from "@/src/hooks/useProfileData";
import { uploadToR2 } from "@/src/lib/uploadToR2";
import { optimizeImageForUpload } from '@/src/lib/imageOptimize';
import { FormInput } from "@/src/components/inputs/FormInput";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { SafeAreaView } from "react-native-safe-area-context";
import { Left_Arrow, Email_Icon, Add_Icon } from "@/assets/svgs";
import { Ionicons } from "@/src/lib/icons";
import { CountryPicker } from "react-native-country-codes-picker";
import { callApi } from "@/src/services/api"; // Centralized Worker API Caller
import { ReanimatedBottomSheet } from "@/src/components/modals/ReanimatedBottomSheet";

const { height: SCREEN_HEIGHT } = Dimensions.get('window');

const DISPOSABLE_DOMAINS = [
  'yopmail.com', 'tempmail.com', 'guerrillamail.com', '10minutemail.com', 
  'mailinator.com', 'getnada.com', 'dispostable.com', 'throwawaymail.com'
];

const editProfileSchema = z.object({
  fullName: z.string().min(1, "Please fill in your full name"),
  email: z.string()
    .min(1, "Email is required")
    .email("Invalid email address")
    .refine((email) => {
        const domain = email.split('@')[1];
        return !DISPOSABLE_DOMAINS.includes(domain);
    }, { message: "Temporary/Fake emails are not allowed" }),
  phone: z.string()
    .min(1, "Please fill in your phone number")
    .length(10, "Phone number must be exactly 10 digits")
    .regex(/^[0-9]+$/, "Phone number must contain only digits"),
  occupation: z.string().min(1, "Please select your occupation"),
  bio: z.string().max(150, "Bio must be less than 150 characters").optional(),
  facebook: z.string().optional(),
  twitter: z.string().optional(),
  instagram: z.string().optional(),
});

type EditProfileFormValues = z.infer<typeof editProfileSchema>;

const occupations = ["Student", "Engineer", "Doctor", "Artist", "Teacher", "Developer", "Designer", "Manager", "Other"];

export default function EditProfileScreen() {
  const router = useRouter();
  const { user: authUser } = useAuth();
  const { data: profile, isLoading: profileLoading, refetch } = useProfile(authUser?.uid || '');
  
  const [isOccupationPickerVisible, setOccupationPickerVisibility] = useState(false);
  const [showCountryPicker, setShowCountryPicker] = useState(false);
  const [countryCode, setCountryCode] = useState("+91");
  const [isLoading, setIsLoading] = useState(false);
  const [localAvatarUri, setLocalAvatarUri] = useState<string | null>(null);
  
  const [showImageOptions, setShowImageOptions] = useState(false);

  const [showEmailOtpModal, setShowEmailOtpModal] = useState(false);
  const [newEmailToVerify, setNewEmailToVerify] = useState("");
  const [emailOtp, setEmailOtp] = useState("");
  const [isSendingEmailOtp, setIsSendingEmailOtp] = useState(false);
  const [isVerifyingEmailOtp, setIsVerifyingEmailOtp] = useState(false);

  const [showPhoneOtpModal, setShowPhoneOtpModal] = useState(false);
  const [newPhoneToVerify, setNewPhoneToVerify] = useState("");
  const [phoneOtp, setPhoneOtp] = useState("");
  const [isSendingPhoneOtp, setIsSendingPhoneOtp] = useState(false);
  const [isVerifyingPhoneOtp, setIsVerifyingPhoneOtp] = useState(false);

  const {
    control,
    handleSubmit,
    setValue,
    watch,
    trigger,
    formState: { errors },
    reset
  } = useForm<EditProfileFormValues>({
    resolver: zodResolver(editProfileSchema),
    mode: "onChange"
  });

  const currentEmail = profile?.email;
  const currentPhone = profile?.phone;
  const watchedEmail = watch("email");
  const watchedPhone = watch("phone");

  useEffect(() => {
    if (profile) {
      // Split the stored E.164-style number into dial code + 10-digit local part.
      // Using a hardcoded "+91" replace() mangled numbers saved with any other
      // country code (the prefix was left in the field and the picker was wrong).
      const rawPhone = profile.phone || "";
      let localPhone = rawPhone;
      if (rawPhone.startsWith("+")) {
        localPhone = rawPhone.slice(-10);
        const dial = rawPhone.slice(0, rawPhone.length - 10);
        if (dial) setCountryCode(dial);
      }
      reset({
        fullName: profile.fullName || "",
        email: profile.email || "",
        phone: localPhone,
        occupation: (profile as any).occupation || "",
        bio: profile.bio || "",
        facebook: (profile as any).facebook || "",
        twitter: (profile as any).twitter || "",
        instagram: (profile as any).instagram || "",
      });
      setLocalAvatarUri(profile.profileImageUrl || null);
    }
  }, [profile, reset]);

  const selectedOccupation = watch("occupation");

  const pickImage = async (useCamera: boolean) => {
    setShowImageOptions(false);
    
    let result;
    if (useCamera) {
        const permission = await ImagePicker.requestCameraPermissionsAsync();
        if (permission.granted) {
            result = await ImagePicker.launchCameraAsync({
                allowsEditing: true,
                aspect: [1, 1],
                quality: 0.5,
            });
        } else {
            Alert.alert("Permission Denied", "Camera permission is required to take a photo.");
            return;
        }
    } else {
        result = await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ['images'],
            allowsEditing: true,
            aspect: [1, 1],
            quality: 0.5,
        });
    }

    if (result && !result.canceled && result.assets) {
        setLocalAvatarUri(result.assets[0].uri);
    }
  };

  const handleSendEmailOtp = async () => {
    const isValid = await trigger("email");
    if (!isValid) return;

    if (!watchedEmail || watchedEmail === currentEmail) return;
    
    setIsSendingEmailOtp(true);
    try {
        // Using callApi with 'sendEmailOtp' action
        await callApi('sendEmailOtp', { newEmail: watchedEmail });
        setNewEmailToVerify(watchedEmail);
        setShowEmailOtpModal(true);
    } catch (error: any) {
        Alert.alert("Error", error.message || "Failed to send OTP.");
    } finally {
        setIsSendingEmailOtp(false);
    }
  };

  const handleVerifyEmailOtp = async () => {
      if (emailOtp.length !== 6) {
          Alert.alert("Invalid OTP", "Please enter a 6-digit OTP.");
          return;
      }
      setIsVerifyingEmailOtp(true);
      try {
          // Using callApi with 'verifyEmailOtp' action
          const result: any = await callApi('verifyEmailOtp', { otp: emailOtp });
          if (result.success) {
              Alert.alert("Success", "Email updated successfully!");
              setShowEmailOtpModal(false);
              setEmailOtp("");
              refetch();
          }
      } catch (error: any) {
          Alert.alert("Error", error.message || "Invalid OTP.");
      } finally {
          setIsVerifyingEmailOtp(false);
      }
  };

  const handleSendPhoneOtp = async () => {
    const isValid = await trigger("phone");
    if (!isValid) return;

    const fullPhone = countryCode + watchedPhone;
    if (!watchedPhone || fullPhone === currentPhone) return;
    
    setIsSendingPhoneOtp(true);
    try {
        // Using callApi with 'sendPhoneOtp' action
        await callApi('sendPhoneOtp', { newPhone: fullPhone });
        setNewPhoneToVerify(fullPhone);
        setShowPhoneOtpModal(true);
    } catch (error: any) {
        Alert.alert("Error", error.message || "Failed to send SMS.");
    } finally {
        setIsSendingPhoneOtp(false);
    }
  };

  const handleVerifyPhoneOtp = async () => {
      if (phoneOtp.length !== 6) {
          Alert.alert("Invalid OTP", "Please enter a 6-digit OTP.");
          return;
      }
      setIsVerifyingPhoneOtp(true);
      try {
          // Using callApi with 'verifyPhoneOtp' action
          const result: any = await callApi('verifyPhoneOtp', { otp: phoneOtp });
          if (result.success) {
              Alert.alert("Success", "Phone number updated successfully!");
              setShowPhoneOtpModal(false);
              setPhoneOtp("");
              refetch();
          }
      } catch (error: any) {
          Alert.alert("Error", error.message || "Invalid OTP.");
      } finally {
          setIsVerifyingPhoneOtp(false);
      }
  };

  const onSubmit = async (data: EditProfileFormValues) => {
    if (!authUser) return;
    setIsLoading(true);
    try {
      let finalAvatarUrl = profile?.profileImageUrl;

      if (localAvatarUri && localAvatarUri !== profile?.profileImageUrl) {
        const optimizedAvatar = await optimizeImageForUpload(localAvatarUri, "avatar");
        finalAvatarUrl = await uploadToR2(optimizedAvatar, "image/jpeg", "avatars") as string;
      }

      await callApi('updateProfile', {
        fullName: data.fullName,
        occupation: data.occupation,
        bio: data.bio || "",
        facebook: data.facebook || "",
        twitter: data.twitter || "",
        instagram: data.instagram || "",
        profileImageUrl: finalAvatarUrl,
      });

      let alertMsg = "Profile updated successfully!";
      let needsVerification = false;

      if (data.email !== currentEmail) {
          handleSendEmailOtp();
          alertMsg = "Profile details updated. Please verify your new email to complete the change.";
          needsVerification = true;
      } else if ((countryCode + data.phone) !== currentPhone) {
          handleSendPhoneOtp();
          alertMsg = "Profile details updated. Please verify your new phone number to complete the change.";
          needsVerification = true;
      }

      if (!needsVerification) {
          Alert.alert("Success", alertMsg);
          refetch();
          router.back();
      } else {
          Alert.alert("Action Required", alertMsg);
          refetch();
      }
    } catch (error) {
      console.error("Update error", error);
      Alert.alert("Error", "Something went wrong. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  if (profileLoading) {
    return <View style={styles.center}><ActivityIndicator size="large" color="#ff4466" /></View>;
  }

  const isEmailChanged = watchedEmail !== currentEmail && watchedEmail?.length > 5;
  const isPhoneChanged = (countryCode + watchedPhone) !== currentPhone && watchedPhone?.length === 10;

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()}>
          <Left_Arrow width={24} height={24} color="#000" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Edit Profile</Text>
        <View style={{ width: 24 }} />
      </View>

      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        <View style={styles.avatarContainer}>
          <TouchableOpacity onPress={() => setShowImageOptions(true)} style={styles.avatarWrapper}>
             <Image 
                source={localAvatarUri ? { uri: localAvatarUri } : require('@/assets/images/userLight.png')} 
                style={styles.avatar} 
             />
            <View style={styles.editIconContainer}>
                <Add_Icon width={16} height={16} color="white" />
            </View>
          </TouchableOpacity>
        </View>

        <Text style={styles.sectionHeader}>About You</Text>

        <FormInput
          control={control}
          name="fullName"
          placeholder="Full Name"
          errorMessage={errors.fullName?.message}
        />

        <FormInput
          control={control}
          name="bio"
          placeholder="Bio"
          multiline
          numberOfLines={3}
          errorMessage={errors.bio?.message}
        />

        <View>
            <FormInput
            control={control}
            name="email"
            placeholder="Email"
            rightIcon={
                isSendingEmailOtp ? 
                <View style={{ paddingRight: 10 }}><ActivityIndicator size="small" color="#ff4466" /></View> : 
                isEmailChanged ?
                <TouchableOpacity onPress={handleSendEmailOtp} style={styles.verifyBtnWrapper}>
                    <Text style={styles.verifyBtnInline}>Verify</Text>
                </TouchableOpacity> :
                <View style={{ paddingRight: 10 }}><Email_Icon width={20} height={20} color="#9E9E9E" /></View>
            }
            keyboardType="email-address"
            errorMessage={errors.email?.message}
            />
        </View>

        <View>
            <View style={styles.phoneInputRow}>
                <TouchableOpacity style={styles.flagButton} onPress={() => setShowCountryPicker(true)}>
                    <Text style={styles.flagText}>{countryCode}</Text>
                    <Ionicons name="chevron-down" size={12} color="#9E9E9E" style={{ marginLeft: 4 }} />
                </TouchableOpacity>
                <View style={styles.phoneNumberInputWrapper}>
                    <FormInput
                        control={control}
                        name="phone"
                        placeholder="Phone Number"
                        containerStyle={{ flex: 1, marginBottom: 0 }}
                        keyboardType="phone-pad"
                        errorMessage={errors.phone?.message}
                        rightIcon={
                            isSendingPhoneOtp ? 
                            <View style={{ paddingRight: 10 }}><ActivityIndicator size="small" color="#ff4466" /></View> : 
                            isPhoneChanged ?
                            <TouchableOpacity onPress={handleSendPhoneOtp} style={styles.verifyBtnWrapper}>
                                <Text style={styles.verifyBtnInline}>Verify</Text>
                            </TouchableOpacity> :
                            null
                        }
                    />
                </View>
            </View>
        </View>

        <View style={{ marginBottom: 20 }}>
          <TouchableOpacity
            style={[styles.dropdownContainer, errors.occupation && styles.inputError]}
            onPress={() => setOccupationPickerVisibility(true)}
          >
              <Text style={[styles.dropdownText, !selectedOccupation && { color: '#9E9E9E' }]}>
                  {selectedOccupation || "Occupation"}
              </Text>
              <Ionicons name="chevron-down" size={20} color="#9E9E9E" />
          </TouchableOpacity>
        </View>

        <Text style={styles.sectionHeader}>Social</Text>

        <FormInput
          control={control}
          name="facebook"
          placeholder="Facebook Username"
          errorMessage={errors.facebook?.message}
        />

        <FormInput
          control={control}
          name="twitter"
          placeholder="Twitter Username"
          errorMessage={errors.twitter?.message}
        />

        <FormInput
          control={control}
          name="instagram"
          placeholder="Instagram Username"
          errorMessage={errors.instagram?.message}
        />

        <TouchableOpacity onPress={handleSubmit(onSubmit)} style={styles.updateButton} disabled={isLoading || isSendingEmailOtp || isSendingPhoneOtp}>
          {isLoading ? <ActivityIndicator color="white" /> : <Text style={styles.updateButtonText}>Update</Text>}
        </TouchableOpacity>
      </ScrollView>

      <CountryPicker
        lang="en"
        show={showCountryPicker}
        pickerButtonOnPress={(item) => { setCountryCode(item.dial_code); setShowCountryPicker(false); }}
        onBackdropPress={() => setShowCountryPicker(false)}
        style={{ modal: { height: 500 } }}
      />

      {/* Image Options Modal */}
      <ReanimatedBottomSheet 
        visible={showImageOptions} 
        onClose={() => setShowImageOptions(false)}
        title="Change Profile Photo"
      >
        <TouchableOpacity style={styles.modalOption} onPress={() => pickImage(true)}>
            <Ionicons name="camera-outline" size={24} color="#000" />
            <Text style={[styles.modalOptionText, { marginLeft: 12 }]}>Take Photo</Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.modalOption} onPress={() => pickImage(false)}>
            <Ionicons name="image-outline" size={24} color="#000" />
            <Text style={[styles.modalOptionText, { marginLeft: 12 }]}>Choose from Library</Text>
        </TouchableOpacity>

        {localAvatarUri && (
          <TouchableOpacity style={[styles.modalOption, { borderBottomWidth: 0 }]} onPress={() => { setLocalAvatarUri(null); setShowImageOptions(false); }}>
              <Ionicons name="trash-outline" size={24} color="red" />
              <Text style={[styles.modalOptionText, { marginLeft: 12, color: 'red' }]}>Remove Photo</Text>
          </TouchableOpacity>
        )}
      </ReanimatedBottomSheet>

      {/* Email OTP Verification Modal */}
      <ReanimatedBottomSheet 
        visible={showEmailOtpModal} 
        onClose={() => setShowEmailOtpModal(false)}
        title="Verify New Email"
      >
          <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined}>
            <View style={styles.otpModalBody}>
                <Text style={styles.modalSubtitle}>Enter the 6-digit OTP sent to {newEmailToVerify}</Text>
                <TextInput
                    style={styles.otpInput}
                    placeholder="000000"
                    keyboardType="number-pad"
                    maxLength={6}
                    value={emailOtp}
                    onChangeText={setEmailOtp}
                    autoFocus
                />
                <TouchableOpacity style={styles.verifyButton} onPress={handleVerifyEmailOtp} disabled={isVerifyingEmailOtp}>
                    {isVerifyingEmailOtp ? <ActivityIndicator color="white" /> : <Text style={styles.verifyButtonText}>Verify & Update Email</Text>}
                </TouchableOpacity>
                <TouchableOpacity onPress={() => setShowEmailOtpModal(false)} style={styles.cancelButton}>
                    <Text style={styles.cancelButtonText}>Cancel</Text>
                </TouchableOpacity>
            </View>
          </KeyboardAvoidingView>
      </ReanimatedBottomSheet>

      {/* Phone OTP Verification Modal */}
      <ReanimatedBottomSheet 
        visible={showPhoneOtpModal} 
        onClose={() => setShowPhoneOtpModal(false)}
        title="Verify New Phone"
      >
          <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined}>
            <View style={styles.otpModalBody}>
                <Text style={styles.modalSubtitle}>Enter the 6-digit OTP sent via SMS to {newPhoneToVerify}</Text>
                <TextInput
                    style={styles.otpInput}
                    placeholder="000000"
                    keyboardType="number-pad"
                    maxLength={6}
                    value={phoneOtp}
                    onChangeText={setPhoneOtp}
                    autoFocus
                />
                <TouchableOpacity style={styles.verifyButton} onPress={handleVerifyPhoneOtp} disabled={isVerifyingPhoneOtp}>
                    {isVerifyingPhoneOtp ? <ActivityIndicator color="white" /> : <Text style={styles.verifyButtonText}>Verify & Update Phone</Text>}
                </TouchableOpacity>
                <TouchableOpacity onPress={() => setShowPhoneOtpModal(false)} style={styles.cancelButton}>
                    <Text style={styles.cancelButtonText}>Cancel</Text>
                </TouchableOpacity>
            </View>
          </KeyboardAvoidingView>
      </ReanimatedBottomSheet>

      {/* Occupation Modal */}
      <ReanimatedBottomSheet 
        visible={isOccupationPickerVisible} 
        onClose={() => setOccupationPickerVisibility(false)}
        title="Select Occupation"
        maxHeight={SCREEN_HEIGHT * 0.6}
      >
        <ScrollView style={{ maxHeight: SCREEN_HEIGHT * 0.5 }} showsVerticalScrollIndicator={false}>
            {occupations.map((occ) => (
                <TouchableOpacity key={occ} style={styles.modalOption} onPress={() => { setValue('occupation', occ); setOccupationPickerVisibility(false); }}>
                    <Text style={[styles.modalOptionText, selectedOccupation === occ && styles.selectedOptionText, { flex: 1 }]}>{occ}</Text>
                    {selectedOccupation === occ && <Ionicons name="checkmark" size={24} color="#ff4466" />}
                </TouchableOpacity>
            ))}
        </ScrollView>
      </ReanimatedBottomSheet>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 20, paddingVertical: 10 },
  headerTitle: { fontSize: 22, fontFamily: "Urbanist-Bold", color: "#000" },
  scrollContent: { paddingHorizontal: 24, paddingBottom: 40 },
  avatarContainer: { alignItems: "center", marginVertical: 30 },
  avatarWrapper: { position: "relative" },
  avatar: { width: 120, height: 120, borderRadius: 60, backgroundColor: '#F5F5F5' },
  editIconContainer: { position: 'absolute', bottom: 5, right: 5, backgroundColor: '#ff4466', borderRadius: 8, padding: 4, borderWidth: 2, borderColor: '#fff', width: 28, height: 28, justifyContent: 'center', alignItems: 'center' },
  sectionHeader: { fontSize: 18, fontFamily: "Urbanist-Bold", color: "#000", marginTop: 20, marginBottom: 10 },
  phoneInputRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 20, gap: 12 },
  flagButton: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#FAFAFA', borderRadius: 12, paddingHorizontal: 12, height: 56 },
  flagText: { fontSize: 16, fontFamily: "Urbanist-Medium", color: "#000" },
  phoneNumberInputWrapper: { flex: 1 },
  dropdownContainer: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#FAFAFA', borderRadius: 12, paddingHorizontal: 16, height: 56 },
  inputError: { borderColor: 'red', borderWidth: 1 },
  dropdownText: { fontSize: 16, color: '#000', fontFamily: "Urbanist-Medium" },
  updateButton: { backgroundColor: "#ff4466", paddingVertical: 18, borderRadius: 30, marginTop: 20 },
  updateButtonText: { color: "white", textAlign: "center", fontSize: 16, fontWeight: "bold", fontFamily: "Urbanist-SemiBold" },
  modalOption: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-start', paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: '#F5F5F5' },
  modalOptionText: { fontSize: 18, fontFamily: 'Urbanist-SemiBold', color: '#424242' },
  selectedOptionText: { color: '#ff4466', fontFamily: 'Urbanist-Bold' },
  verifyLink: { marginTop: -15, marginBottom: 15, alignSelf: 'flex-end' },
  verifyText: { color: '#ff4466', fontWeight: 'bold', fontSize: 12 },
  verifyBtnWrapper: { paddingRight: 10, justifyContent: 'center' },
  verifyBtnInline: { color: '#ff4466', fontFamily: 'Urbanist-Bold', fontSize: 14 },
  modalSubtitle: { fontSize: 14, color: '#666', textAlign: 'center', marginBottom: 20 },
  otpModalBody: { paddingBottom: 20 },
  otpInput: { borderBottomWidth: 2, borderBottomColor: '#ff4466', fontSize: 24, textAlign: 'center', marginVertical: 20, letterSpacing: 10, paddingVertical: 10 },
  verifyButton: { backgroundColor: '#ff4466', paddingVertical: 15, borderRadius: 30, alignItems: 'center' },
  verifyButtonText: { color: 'white', fontWeight: 'bold', fontSize: 16 },
  cancelButton: { marginTop: 15, alignItems: 'center' },
  cancelButtonText: { color: '#666', fontSize: 14 },
});