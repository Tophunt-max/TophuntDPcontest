import React, { useState, useEffect } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  Image,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  Modal,
  Alert,
  TextInput,
} from "react-native";
import { useRouter } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import { useAuth } from "@/src/services/auth";
import { useProfile } from "@/src/hooks/useProfileData";
import { uploadToS3 } from "@/src/lib/uploadToS3";
import { FormInput } from "@/src/components/inputs/FormInput";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { SafeAreaView } from "react-native-safe-area-context";
import { Left_Arrow, Email_Icon } from "@/assets/svgs";
import { Ionicons } from "@expo/vector-icons";
import { CountryPicker } from "react-native-country-codes-picker";
import { doc, updateDoc } from "firebase/firestore";
import { firestore, functions } from "@/src/services/firebase/initFirebase";
import { httpsCallable } from "firebase/functions";
import { useActionSheet } from '@expo/react-native-action-sheet'; // You might need to install this or implement a custom sheet

const editProfileSchema = z.object({
  fullName: z.string().min(1, "Please fill in your full name"),
  email: z.string().min(1, "Email is required").email("Invalid email address"),
  phone: z.string().min(1, "Please fill in your phone number").min(10, "Phone number must be at least 10 digits"),
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
  
  // Image Options Modal
  const [showImageOptions, setShowImageOptions] = useState(false);

  // Email Update State
  const [showEmailOtpModal, setShowEmailOtpModal] = useState(false);
  const [newEmailToVerify, setNewEmailToVerify] = useState("");
  const [emailOtp, setEmailOtp] = useState("");
  const [isSendingEmailOtp, setIsSendingEmailOtp] = useState(false);
  const [isVerifyingEmailOtp, setIsVerifyingEmailOtp] = useState(false);

  // Phone Update State
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
  });

  const currentEmail = profile?.email;
  const currentPhone = profile?.phone;
  const watchedEmail = watch("email");
  const watchedPhone = watch("phone");

  useEffect(() => {
    if (profile) {
      reset({
        fullName: profile.fullName || "",
        email: profile.email || "",
        phone: profile.phone?.replace(countryCode, "") || "",
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
    if (!watchedEmail || watchedEmail === currentEmail) return;
    setIsSendingEmailOtp(true);
    try {
        const sendEmailUpdateOtp = httpsCallable(functions, 'sendEmailUpdateOtp');
        await sendEmailUpdateOtp({ newEmail: watchedEmail });
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
          const verifyEmailUpdateOtp = httpsCallable(functions, 'verifyEmailUpdateOtp');
          const result = await verifyEmailUpdateOtp({ otp: emailOtp });
          if ((result.data as any).success) {
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
    const fullPhone = countryCode + watchedPhone;
    if (!watchedPhone || fullPhone === currentPhone) return;
    setIsSendingPhoneOtp(true);
    try {
        const sendPhoneUpdateOtp = httpsCallable(functions, 'sendPhoneUpdateOtp');
        await sendPhoneUpdateOtp({ newPhone: fullPhone });
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
          const verifyPhoneUpdateOtp = httpsCallable(functions, 'verifyPhoneUpdateOtp');
          const result = await verifyPhoneUpdateOtp({ otp: phoneOtp });
          if ((result.data as any).success) {
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
        finalAvatarUrl = await uploadToS3(localAvatarUri, "image/jpeg", "avatars") as string;
      }

      const userRef = doc(firestore, "users", authUser.uid);
      await updateDoc(userRef, {
        fullName: data.fullName,
        occupation: data.occupation,
        bio: data.bio || "",
        facebook: data.facebook || "",
        twitter: data.twitter || "",
        instagram: data.instagram || "",
        profileImageUrl: finalAvatarUrl,
        updatedAt: new Date(),
      });

      let alertMsg = "Profile updated successfully!";
      let needsVerification = false;

      if (data.email !== currentEmail) {
          handleSendEmailOtp();
          alertMsg = "Profile updated. An OTP has been sent to verify your new email.";
          needsVerification = true;
      }

      if ((countryCode + data.phone) !== currentPhone) {
          handleSendPhoneOtp();
          alertMsg = needsVerification ? "Profile updated. OTPs sent to verify new email and phone." : "Profile updated. An OTP has been sent to verify your new phone number.";
          needsVerification = true;
      }

      Alert.alert("Success", alertMsg);
      refetch();
      if (!needsVerification) router.back();
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
                <Ionicons name="pencil" size={18} color="white" />
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
            rightIcon={isSendingEmailOtp ? <ActivityIndicator size="small" color="#ff4466" /> : <Email_Icon width={20} height={20} color="#9E9E9E" />}
            keyboardType="email-address"
            errorMessage={errors.email?.message}
            />
            {watchedEmail !== currentEmail && watchedEmail?.length > 5 && (
                <TouchableOpacity style={styles.verifyLink} onPress={handleSendEmailOtp}>
                    <Text style={styles.verifyText}>Verify Email Change</Text>
                </TouchableOpacity>
            )}
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
                        rightIcon={isSendingPhoneOtp ? <ActivityIndicator size="small" color="#ff4466" /> : null}
                    />
                </View>
            </View>
            {(countryCode + watchedPhone) !== currentPhone && watchedPhone?.length >= 10 && (
                <TouchableOpacity style={styles.verifyLink} onPress={handleSendPhoneOtp}>
                    <Text style={styles.verifyText}>Verify Phone Change</Text>
                </TouchableOpacity>
            )}
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
        show={showCountryPicker}
        pickerButtonOnPress={(item) => { setCountryCode(item.dial_code); setShowCountryPicker(false); }}
        onBackdropPress={() => setShowCountryPicker(false)}
        style={{ modal: { height: 500 } }}
      />

      {/* Image Options Modal */}
      <Modal transparent visible={showImageOptions} animationType="fade">
        <TouchableOpacity style={styles.modalOverlay} onPress={() => setShowImageOptions(false)}>
            <View style={styles.modalContent}>
                <Text style={styles.modalTitle}>Change Profile Photo</Text>
                
                <TouchableOpacity style={styles.modalOption} onPress={() => pickImage(true)}>
                    <Ionicons name="camera-outline" size={24} color="#000" />
                    <Text style={[styles.modalOptionText, { marginLeft: 10 }]}>Take Photo</Text>
                </TouchableOpacity>

                <TouchableOpacity style={styles.modalOption} onPress={() => pickImage(false)}>
                    <Ionicons name="image-outline" size={24} color="#000" />
                    <Text style={[styles.modalOptionText, { marginLeft: 10 }]}>Choose from Library</Text>
                </TouchableOpacity>

                {localAvatarUri && (
                  <TouchableOpacity style={[styles.modalOption, { borderBottomWidth: 0 }]} onPress={() => { setLocalAvatarUri(null); setShowImageOptions(false); }}>
                      <Ionicons name="trash-outline" size={24} color="red" />
                      <Text style={[styles.modalOptionText, { marginLeft: 10, color: 'red' }]}>Remove Photo</Text>
                  </TouchableOpacity>
                )}
            </View>
        </TouchableOpacity>
      </Modal>

      {/* Email OTP Verification Modal */}
      <Modal transparent visible={showEmailOtpModal} animationType="slide">
          <View style={styles.modalOverlay}>
              <View style={styles.otpModalContent}>
                  <Text style={styles.modalTitle}>Verify New Email</Text>
                  <Text style={styles.modalSubtitle}>Enter the 6-digit OTP sent to {newEmailToVerify}</Text>
                  <TextInput
                    style={styles.otpInput}
                    placeholder="000000"
                    keyboardType="number-pad"
                    maxLength={6}
                    value={emailOtp}
                    onChangeText={setEmailOtp}
                  />
                  <TouchableOpacity style={styles.verifyButton} onPress={handleVerifyEmailOtp} disabled={isVerifyingEmailOtp}>
                      {isVerifyingEmailOtp ? <ActivityIndicator color="white" /> : <Text style={styles.verifyButtonText}>Verify & Update Email</Text>}
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => setShowEmailOtpModal(false)} style={styles.cancelButton}>
                      <Text style={styles.cancelButtonText}>Cancel</Text>
                  </TouchableOpacity>
              </View>
          </View>
      </Modal>

      {/* Phone OTP Verification Modal */}
      <Modal transparent visible={showPhoneOtpModal} animationType="slide">
          <View style={styles.modalOverlay}>
              <View style={styles.otpModalContent}>
                  <Text style={styles.modalTitle}>Verify New Phone</Text>
                  <Text style={styles.modalSubtitle}>Enter the 6-digit OTP sent via SMS to {newPhoneToVerify}</Text>
                  <TextInput
                    style={styles.otpInput}
                    placeholder="000000"
                    keyboardType="number-pad"
                    maxLength={6}
                    value={phoneOtp}
                    onChangeText={setPhoneOtp}
                  />
                  <TouchableOpacity style={styles.verifyButton} onPress={handleVerifyPhoneOtp} disabled={isVerifyingPhoneOtp}>
                      {isVerifyingPhoneOtp ? <ActivityIndicator color="white" /> : <Text style={styles.verifyButtonText}>Verify & Update Phone</Text>}
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => setShowPhoneOtpModal(false)} style={styles.cancelButton}>
                      <Text style={styles.cancelButtonText}>Cancel</Text>
                  </TouchableOpacity>
              </View>
          </View>
      </Modal>

      {/* Occupation Modal */}
      <Modal transparent visible={isOccupationPickerVisible} animationType="fade">
        <TouchableOpacity style={styles.modalOverlay} onPress={() => setOccupationPickerVisibility(false)}>
            <View style={[styles.modalContent, { maxHeight: '60%' }]}>
                <Text style={styles.modalTitle}>Select Occupation</Text>
                <ScrollView>
                    {occupations.map((occ) => (
                        <TouchableOpacity key={occ} style={styles.modalOption} onPress={() => { setValue('occupation', occ); setOccupationPickerVisibility(false); }}>
                            <Text style={[styles.modalOptionText, selectedOccupation === occ && styles.selectedOptionText]}>{occ}</Text>
                            {selectedOccupation === occ && <Ionicons name="checkmark" size={24} color="#ff4466" />}
                        </TouchableOpacity>
                    ))}
                </ScrollView>
            </View>
        </TouchableOpacity>
      </Modal>
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
  editIconContainer: { position: 'absolute', bottom: 5, right: 5, backgroundColor: '#ff4466', borderRadius: 8, padding: 4, borderWidth: 2, borderColor: '#fff' },
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
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  modalContent: { backgroundColor: '#fff', borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingBottom: 40, paddingHorizontal: 24, paddingTop: 24 },
  otpModalContent: { backgroundColor: '#fff', borderRadius: 24, padding: 24, margin: 20, width: '90%', alignSelf: 'center', marginBottom: 'auto', marginTop: 'auto' },
  modalTitle: { fontSize: 20, fontFamily: 'Urbanist-Bold', color: '#000', textAlign: 'center', marginBottom: 8 },
  modalSubtitle: { fontSize: 14, color: '#666', textAlign: 'center', marginBottom: 20 },
  modalOption: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-start', paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: '#F5F5F5' },
  modalOptionText: { fontSize: 18, fontFamily: 'Urbanist-SemiBold', color: '#424242' },
  selectedOptionText: { color: '#ff4466', fontFamily: 'Urbanist-Bold' },
  verifyLink: { marginTop: -15, marginBottom: 15, alignSelf: 'flex-end' },
  verifyText: { color: '#ff4466', fontWeight: 'bold', fontSize: 12 },
  otpInput: { borderBottomWidth: 2, borderBottomColor: '#ff4466', fontSize: 24, textAlign: 'center', marginVertical: 20, letterSpacing: 10, paddingVertical: 10 },
  verifyButton: { backgroundColor: '#ff4466', paddingVertical: 15, borderRadius: 30, alignItems: 'center' },
  verifyButtonText: { color: 'white', fontWeight: 'bold', fontSize: 16 },
  cancelButton: { marginTop: 15, alignItems: 'center' },
  cancelButtonText: { color: '#666', fontSize: 14 },
});
