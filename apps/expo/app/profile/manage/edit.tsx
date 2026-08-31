import React, { useState, useEffect } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  Image,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  TextInput,
  Dimensions,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { Alert } from '@/src/lib/appAlert';
import { useRouter } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import { useReadjustablePhoto } from "@/src/components/media/useImageAdjuster";
import { useAuth } from "@/src/hooks/useAuth";
import { useProfile } from "@/src/hooks/useProfileData";
import { uploadToR2 } from "@/src/lib/uploadToR2";
import { optimizeImageForUpload } from '@/src/lib/imageOptimize';
import { FormInput } from "@/src/components/inputs/FormInput";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { SafeAreaView } from "react-native-safe-area-context";
import { Email_Icon, Add_Icon } from "@/assets/svgs";
import { BackButton } from "@/src/components/ui/BackButton";
import { Ionicons } from "@/src/lib/icons";
import { CountryPicker } from "react-native-country-codes-picker";
import { callApi } from "@/src/services/api"; // Centralized Worker API Caller
import { ReanimatedBottomSheet } from "@/src/components/modals/ReanimatedBottomSheet";
import { ReauthPrompt } from "@/src/components/modals/ReauthPrompt";
import { isReauthRequired } from "@/src/services/auth/reauth";

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
  // Digits only, but NOT exactly 10. This used to be `.length(10)`, which is an
  // Indian mobile number — while the screen has a country picker offering every
  // dial code. Anyone whose national number is not 10 digits could not save their
  // number at all, and never saw the Verify button. The server validates the full
  // number (dial code included) against 7-15 digits, so the real bound lives
  // there; this only has to catch obvious typos.
  phone: z.string()
    .min(6, "Please enter a valid phone number")
    .max(14, "Please enter a valid phone number")
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
  const { adjustPicked, readjust, canReadjust, forget, host: adjusterHost } = useReadjustablePhoto(1);
  
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

  /**
   * Seconds left before another code may be requested.
   *
   * The server enforces a 60s per-destination cooldown and returns it. Without
   * mirroring it there was no Resend at all, so a code that never arrived (or was
   * deleted) left the user with nothing to do but back out and start again — and
   * every blind retry silently consumed one of their ten hourly sends.
   */
  const [emailCooldown, setEmailCooldown] = useState(0);
  const [phoneCooldown, setPhoneCooldown] = useState(0);

  /**
   * Which identifier change is waiting on "confirm it's you", if any.
   *
   * Moving an email or phone number is a credential change, so the server requires
   * a recent sign-in. Remembering WHICH one was refused is what lets the flow
   * resume by itself once the user has verified, instead of making them find the
   * Verify button again and wonder whether the first attempt did anything.
   */
  const [reauthFor, setReauthFor] = useState<'email' | 'phone' | null>(null);

  useEffect(() => {
    if (emailCooldown <= 0 && phoneCooldown <= 0) return;
    const timer = setInterval(() => {
      setEmailCooldown((s) => (s > 0 ? s - 1 : 0));
      setPhoneCooldown((s) => (s > 0 ? s - 1 : 0));
    }, 1000);
    return () => clearInterval(timer);
  }, [emailCooldown, phoneCooldown]);

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
            // Crop with the cross-platform 1:1 adjuster below instead of the
            // native-only allowsEditing UI.
            result = await ImagePicker.launchCameraAsync({ quality: 0.5 });
        } else {
            Alert.alert("Permission Denied", "Camera permission is required to take a photo.");
            return;
        }
    } else {
        result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.5 });
    }

    if (result && !result.canceled && result.assets) {
        setLocalAvatarUri(await adjustPicked(result.assets[0].uri));
    }
  };

  /**
   * Reopen the adjuster on the ORIGINAL photo.
   *
   * Closing the adjuster used to be final — the only way to re-frame was to pick
   * the photo again, which on this screen meant re-opening the camera. Cropping
   * always restarts from the original, so it never compounds.
   */
  const handleReadjust = async () => {
    setShowImageOptions(false);
    const next = await readjust();
    if (next) setLocalAvatarUri(next);
  };

  /**
   * Send a code to the new email address.
   *
   * Returns whether it actually went out, because `onSubmit` used to call this
   * WITHOUT awaiting it and then announce "please verify your new email"
   * regardless — so a rate limit, an invalid address or a dead mail provider
   * became an unhandled rejection while the user was told to check an inbox
   * nothing had been sent to.
   */
  const handleSendEmailOtp = async (): Promise<boolean> => {
    const isValid = await trigger("email");
    if (!isValid) return false;

    if (!watchedEmail || watchedEmail === currentEmail) return false;

    setIsSendingEmailOtp(true);
    try {
        const res: any = await callApi('sendEmailOtp', { newEmail: watchedEmail });
        setNewEmailToVerify(watchedEmail);
        setShowEmailOtpModal(true);
        // The server owns the cooldown; mirroring it here is what makes "Resend"
        // honest instead of a button that fails every time it is pressed.
        setEmailCooldown(Number(res?.cooldownSeconds) || 60);
        return true;
    } catch (error: any) {
        // The session is not recent enough to move a credential. Not an error the
        // user caused, so it gets the "confirm it's you" step rather than an alert.
        if (isReauthRequired(error)) {
            setReauthFor('email');
            return false;
        }
        Alert.alert("Couldn't send the code", error?.message || "Please try again in a moment.");
        return false;
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

  const handleSendPhoneOtp = async (): Promise<boolean> => {
    const isValid = await trigger("phone");
    if (!isValid) return false;

    const fullPhone = countryCode + watchedPhone;
    if (!watchedPhone || fullPhone === currentPhone) return false;

    setIsSendingPhoneOtp(true);
    try {
        const res: any = await callApi('sendPhoneOtp', { newPhone: fullPhone });
        setNewPhoneToVerify(fullPhone);
        setShowPhoneOtpModal(true);
        setPhoneCooldown(Number(res?.cooldownSeconds) || 60);
        return true;
    } catch (error: any) {
        if (isReauthRequired(error)) {
            setReauthFor('phone');
            return false;
        }
        Alert.alert("Couldn't send the code", error?.message || "Please try again in a moment.");
        return false;
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

      /**
       * Identifiers are NOT saved by the call above — they move only after a code
       * sent to the new address or number is confirmed. So all this does is start
       * that verification.
       *
       * This used to be `if (email changed) … else if (phone changed) …`, which
       * meant editing BOTH in one go silently dropped the phone change while the
       * alert said "Profile details updated". Only one code can be collected at a
       * time, so the honest version starts with the email and says plainly that
       * the number is still waiting — the Verify button next to it stays live, so
       * there is somewhere to continue.
       */
      const emailChanged = data.email !== currentEmail;
      const phoneChanged = (countryCode + data.phone) !== currentPhone;

      refetch();

      if (emailChanged) {
        const sent = await handleSendEmailOtp();
        if (sent) {
          Alert.alert(
            "Confirm your email",
            phoneChanged
              ? "Your other details are saved. Enter the code we sent to your new email — then tap Verify next to your phone number to change that too."
              : "Your other details are saved. Enter the code we sent to your new email address to finish the change.",
          );
        }
        return;
      }

      if (phoneChanged) {
        const sent = await handleSendPhoneOtp();
        if (sent) {
          Alert.alert(
            "Confirm your number",
            "Your other details are saved. Enter the code we sent by SMS to finish the change.",
          );
        }
        return;
      }

      Alert.alert("Success", "Profile updated successfully!");
      router.back();
    } catch (error: any) {
      console.error("Update error", error);
      // The server explains itself (a taken username, a banned word, a rate
      // limit). Replacing that with "Something went wrong" threw away the only
      // information the user could have acted on.
      Alert.alert("Couldn't save your profile", error?.message || "Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  if (profileLoading) {
    return <View style={styles.center}><ActivityIndicator size="large" color="#ff4466" /></View>;
  }

  const isEmailChanged = watchedEmail !== currentEmail && watchedEmail?.length > 5;
  // Length is validated by the schema (and re-validated on the server against the
  // full number including the dial code). Hardcoding 10 here meant the Verify
  // button never appeared for any country whose numbers are not 10 digits.
  const isPhoneChanged =
    (countryCode + watchedPhone) !== currentPhone && (watchedPhone?.length ?? 0) >= 6;

  /**
   * Has the identifier currently on the account actually been proven?
   *
   * Nothing surfaced this before, because the backend did not record it. An
   * address entered at signup and never confirmed looked identical to one the user
   * had verified — while still being the address Firebase password reset targets.
   */
  const emailVerified = (profile as any)?.emailVerified === true;
  const phoneVerified = (profile as any)?.phoneVerified === true;
  const showEmailUnverified = !!currentEmail && !emailVerified && !isEmailChanged;
  const showPhoneUnverified = !!currentPhone && !phoneVerified && !isPhoneChanged;

  return (
    <SafeAreaView style={styles.container}>
      {adjusterHost}
      <View style={styles.header}>
        <BackButton size={24} color="#000" />
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
            {showEmailUnverified && (
              <TouchableOpacity
                style={styles.unverifiedRow}
                onPress={handleSendEmailOtp}
                accessibilityRole="button"
                accessibilityLabel="Verify your email address now"
              >
                <Ionicons name="alert-circle-outline" size={14} color="#F59E0B" />
                <Text style={styles.unverifiedText}>
                  Not verified — tap to send a code. Password resets go to this address.
                </Text>
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
            {showPhoneUnverified && (
              <TouchableOpacity
                style={styles.unverifiedRow}
                onPress={handleSendPhoneOtp}
                accessibilityRole="button"
                accessibilityLabel="Verify your phone number now"
              >
                <Ionicons name="alert-circle-outline" size={14} color="#F59E0B" />
                <Text style={styles.unverifiedText}>
                  Not verified — tap to send a code. This number can sign you in.
                </Text>
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

        {canReadjust && (
          <TouchableOpacity style={styles.modalOption} onPress={handleReadjust}>
              <Ionicons name="crop-outline" size={24} color="#000" />
              <Text style={[styles.modalOptionText, { marginLeft: 12 }]}>Adjust Photo</Text>
          </TouchableOpacity>
        )}

        {localAvatarUri && (
          <TouchableOpacity style={[styles.modalOption, { borderBottomWidth: 0 }]} onPress={() => { setLocalAvatarUri(null); forget(); setShowImageOptions(false); }}>
              <Ionicons name="trash-outline" size={24} color="red" />
              <Text style={[styles.modalOptionText, { marginLeft: 12, color: 'red' }]}>Remove Photo</Text>
          </TouchableOpacity>
        )}
      </ReanimatedBottomSheet>

      {/* "Confirm it's you" — required before a credential change. Resumes the
          change that was refused, so the user does not have to start over. */}
      <ReauthPrompt
        visible={reauthFor !== null}
        onClose={() => setReauthFor(null)}
        reason={reauthFor === 'phone' ? 'change your phone number' : 'change your email address'}
        onVerified={() => {
          const pending = reauthFor;
          setReauthFor(null);
          if (pending === 'email') void handleSendEmailOtp();
          else if (pending === 'phone') void handleSendPhoneOtp();
        }}
      />

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
                <TouchableOpacity
                    onPress={handleSendEmailOtp}
                    disabled={emailCooldown > 0 || isSendingEmailOtp}
                    style={styles.resendButton}
                    accessibilityRole="button"
                    accessibilityLabel="Send the code again"
                >
                    <Text style={[styles.resendText, emailCooldown > 0 && styles.resendTextDisabled]}>
                        {emailCooldown > 0 ? `Resend code in ${emailCooldown}s` : "Resend code"}
                    </Text>
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
                <TouchableOpacity
                    onPress={handleSendPhoneOtp}
                    disabled={phoneCooldown > 0 || isSendingPhoneOtp}
                    style={styles.resendButton}
                    accessibilityRole="button"
                    accessibilityLabel="Send the code again"
                >
                    <Text style={[styles.resendText, phoneCooldown > 0 && styles.resendTextDisabled]}>
                        {phoneCooldown > 0 ? `Resend code in ${phoneCooldown}s` : "Resend code"}
                    </Text>
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
  resendButton: { alignItems: 'center', paddingVertical: 10 },
  resendText: { color: '#ff4466', fontSize: 14, fontWeight: '600' },
  resendTextDisabled: { color: '#9E9E9E', fontWeight: '400' },
  unverifiedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: -8,
    marginBottom: 12,
    paddingHorizontal: 4,
  },
  unverifiedText: { flex: 1, color: '#B45309', fontSize: 12 },
});