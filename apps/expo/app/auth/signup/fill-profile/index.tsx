import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  Image,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
} from "react-native";
import React, { useState, useEffect, useCallback } from "react";
import { BackHandler, Platform } from "react-native";
import { signOut } from '@/src/services/auth';
import { router } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import { useReadjustablePhoto } from "@/src/components/media/useImageAdjuster";
import * as Location from 'expo-location';
import { useSignupStore } from "../../../../src/store/signup";
import { FormInput } from "@/src/components/inputs/FormInput";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { SafeAreaView } from "react-native-safe-area-context";
import { Email_Icon, Pencil_Icon } from "@/assets/svgs";
import { BackButton } from "@/src/components/ui/BackButton";
import { Ionicons } from "@/src/lib/icons";
import { DatePickerField } from "@/src/components/inputs/DatePickerField";
import { useToast } from "@/src/components/toast/ToastProvider";
import Images from "@/assets/images";
import Svg, { Circle } from 'react-native-svg';
import { ReanimatedBottomSheet } from "@/src/components/modals/ReanimatedBottomSheet";
import { callApi } from "@/src/services/api"; // Centralized API Caller
import { auth } from "@/src/services/firebase/initFirebase";
import { Alert } from "@/src/lib/appAlert";
import { onboardingDraftFor, onboardingSnapshot, resetOnboarding } from "@/src/lib/profileCompletion";
import { useAppConfig } from "@/src/services/appSettings";
import { getPendingInvite, offerLine } from "@/src/services/referrals";

/**
 * Minimum age.
 *
 * Real-money contests and withdrawals put this app squarely in the category that
 * needs an actual age gate rather than a date picker with a presence check.
 */
const MINIMUM_AGE = 18;

const fillProfileSchema = z.object({
  avatarUrl: z.string().min(1, "Please upload a profile picture"),
  fullName: z.string().min(1, "Full name is required"),
  username: z.string()
    .min(1, "Username is required")
    .min(3, "Must be at least 3 characters")
    .regex(/^[a-zA-Z0-9_.]+$/, "Invalid format"),
  // Email and phone are NOT collected here. They are the sign-in identifier
  // (shown read-only) or are added — and verified by OTP — later from Edit
  // Profile. An identifier typed into a signup form is unproven, and storing it
  // let anyone squat someone else's number. The server ignores them anyway.
  email: z.string().optional(),
  phone: z.string().optional(),
  occupation: z.string().min(1, "Required"),
  gender: z.string().min(1, "Required"),
  // Age gate. This app pays real money out, so a date of birth that is merely
  // PRESENT is not enough — under-18 accounts must not be created at all.
  dateOfBirth: z
    .any()
    .refine((val) => !!val, "Date of birth is required")
    .refine((val) => {
      const dob = val instanceof Date ? val : new Date(val);
      return !Number.isNaN(dob.getTime());
    }, "Enter a valid date of birth")
    .refine((val) => {
      const dob = val instanceof Date ? val : new Date(val);
      // Compare on the calendar, not on 365.25-day arithmetic, so a birthday
      // today counts as having been reached.
      const cutoff = new Date();
      cutoff.setFullYear(cutoff.getFullYear() - MINIMUM_AGE);
      return dob <= cutoff;
    }, `You must be at least ${MINIMUM_AGE} years old to use TopHunt`)
    .refine((val) => {
      const dob = val instanceof Date ? val : new Date(val);
      // Catch obvious typos (year 1900, or a future date) that would otherwise
      // sail through the age check.
      const oldest = new Date();
      oldest.setFullYear(oldest.getFullYear() - 120);
      return dob > oldest && dob <= new Date();
    }, "Enter a valid date of birth"),
});

type FillProfileFormValues = z.infer<typeof fillProfileSchema>;

const occupations = ["Student", "Engineer", "Doctor", "Artist", "Teacher", "Developer", "Designer", "Manager", "Other"];

const CircularProgress = ({ progress, size = 60 }: { progress: number, size?: number }) => {
    const strokeWidth = 4;
    const radius = (size - strokeWidth) / 2;
    const circumference = radius * 2 * Math.PI;
    const offset = circumference - progress * circumference;
    return (
      <View style={{ justifyContent: 'center', alignItems: 'center' }}>
        <Svg width={size} height={size}>
          <Circle stroke="rgba(255, 255, 255, 0.3)" fill="none" cx={size / 2} cy={size / 2} r={radius} strokeWidth={strokeWidth} />
          <Circle stroke="#ff4466" fill="none" cx={size / 2} cy={size / 2} r={radius} strokeWidth={strokeWidth} strokeDasharray={circumference} strokeDashoffset={offset} strokeLinecap="round" transform={`rotate(-90 ${size / 2} ${size / 2})`} />
        </Svg>
        <View style={{ position: 'absolute' }}>
          <Text style={{ color: '#ff4466', fontSize: size * 0.2, fontWeight: 'bold' }}>{Math.round(progress * 100)}%</Text>
        </View>
      </View>
    );
};

const FillProfile: React.FC = () => {
  const { data: signupData, setMultiple, setField, setStep } = useSignupStore();
  // Referral offer (admin-managed, /read/app-config) and a code from an invite link.
  const { config: appConfig } = useAppConfig();
  const referralOffer = appConfig?.referral?.enabled ? offerLine(appConfig.referral) : null;
  useEffect(() => {
    if (signupData.referralCode) return;
    getPendingInvite().then((code) => {
      if (code && !useSignupStore.getState().data.referralCode) setField('referralCode', code);
    });
  }, []);
  const { addToast } = useToast();
  const { adjustPicked, readjust, canReadjust, host: adjusterHost } = useReadjustablePhoto(1);
  
  const [isGenderPickerVisible, setGenderPickerVisibility] = useState(false);
  const [isOccupationPickerVisible, setOccupationPickerVisibility] = useState(false);
  
  // The one identifier this account signs in with, shown read-only. Nothing else.
  const showEmail = signupData.authProvider !== 'phone' && !!signupData.email;
  const showPhone = signupData.authProvider === 'phone' && !!signupData.phone;
  // Social / phone users are ALREADY signed in here (email users are not until
  // the last step), so leaving the form must cancel the signup: sign out, not
  // drop them into the app with no profile.
  const signedInSignup = !!auth.currentUser;

  // Reached without the sign-in screen's hand-off (reload, deep link, sent here
  // by the guard): rebuild the draft from the Firebase user and any half-created
  // profile, so the form is pre-filled rather than empty.
  useEffect(() => {
    const u = auth.currentUser;
    if (!u || signupData.authProvider) return;
    const draft = onboardingDraftFor(u, onboardingSnapshot().uid === u.uid ? onboardingSnapshot().profile : null);
    setMultiple(draft);
    reset({
      avatarUrl: draft.avatarUrl || "",
      fullName: draft.fullName || "",
      username: draft.username || "",
      email: draft.email || "",
      phone: draft.phone || "",
      occupation: draft.occupation || "",
      gender: draft.gender || "",
      dateOfBirth: draft.dob ? new Date(draft.dob) : undefined,
    });
    if (draft.avatarUrl) setLocalAvatarUri(draft.avatarUrl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cancelSignup = useCallback(() => {
    if (!signedInSignup) {
      if (router.canGoBack()) router.back();
      else router.replace("/auth/login");
      return true;
    }
    Alert.alert(
      "Signup cancel karein?",
      "Aapka account abhi bana nahi hai. Cancel karne par aap sign out ho jayenge — baad mein dobara login karke profile poora kar sakte hain.",
      [
        { text: "Continue signup", style: "cancel" },
        {
          text: "Cancel signup",
          style: "destructive",
          onPress: async () => {
            useSignupStore.getState().reset();
            resetOnboarding();
            await signOut({ skipPushTokenUnregister: true }).catch(() => {});
            router.replace("/auth/login");
          },
        },
      ],
    );
    return true;
  }, [signedInSignup]);

  // Android hardware Back asks the same question instead of leaving the form.
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', cancelSignup);
    return () => sub.remove();
  }, [cancelSignup]);

  const [isLoading, setIsLoading] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [localAvatarUri, setLocalAvatarUri] = useState<string | null>(signupData.avatarUrl || null);
  
  const [usernameChecking, setUsernameChecking] = useState(false);

  const { control, handleSubmit, setValue, watch, trigger, setError, clearErrors, reset, formState: { errors } } = useForm<FillProfileFormValues>({
    resolver: zodResolver(fillProfileSchema),
    defaultValues: {
      avatarUrl: signupData.avatarUrl || "",
      fullName: signupData.fullName || "",
      username: signupData.username || "",
      email: signupData.email || "",
      phone: signupData.phone || "",
      occupation: signupData.occupation || "",
      gender: signupData.gender || "",
      dateOfBirth: signupData.dob ? new Date(signupData.dob) : undefined,
    },
  });

  const selectedOccupation = watch("occupation");
  const selectedGender = watch("gender");
  const username = watch("username");

  // SILENT LOCATION
  useEffect(() => {
    (async () => {
        try {
            const { status } = await Location.requestForegroundPermissionsAsync();
            if (status === 'granted') {
                const location = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
                setMultiple({ coordinates: { lat: location.coords.latitude, lng: location.coords.longitude } });
            }
        } catch (e) {}
    })();
  }, []);

  // USERNAME CHECK (Using New API Router)
  useEffect(() => {
    const checkUsername = async () => {
        if (username && username.length >= 3) {
            setUsernameChecking(true);
            try {
                // Purana: authHandler call ko callApi se replace kiya
                const result = await callApi('check', { type: 'username', value: username });
                if (result.exists) {
                    setError("username", { type: "manual", message: "This username is taken. Try another!" });
                } else { clearErrors("username"); }
            } catch (e) {} finally { setUsernameChecking(false); }
        }
    };
    const timer = setTimeout(checkUsername, 500);
    return () => clearTimeout(timer);
  }, [username]);

  const pickAvatar = async () => {
    const img = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.5 });
    if (!img.canceled && img.assets) {
      // Crop to 1:1 with the cross-platform adjuster (native allowsEditing does
      // not run on web). Cancel keeps the original, and the original stays
      // remembered so "Adjust" can reopen it — cancelling is recoverable.
      const finalUri = await adjustPicked(img.assets[0].uri);
      setLocalAvatarUri(finalUri);
      // Defer the actual upload to the final step. During signup the account
      // (and its auth token) doesn't exist yet for email signups, so uploading
      // now would hit the authenticated /upload endpoint and 401 ("Upload
      // failed"). We keep the local URI and upload it in `congratulations`
      // once the account is created and the user is signed in.
      setValue("avatarUrl", finalUri);
      setField("avatarUrl", finalUri);
      trigger("avatarUrl");
    }
  };

  /** Reopen the adjuster on the ORIGINAL pick and re-apply it everywhere. */
  const handleReadjust = async () => {
    const next = await readjust();
    if (!next) return;
    setLocalAvatarUri(next);
    setValue("avatarUrl", next);
    setField("avatarUrl", next);
    trigger("avatarUrl");
  };

  const onSubmit = async (data: FillProfileFormValues) => {
    if (usernameChecking) return;
    setIsLoading(true);
    try {
      // Email/phone stay whatever the sign-in provided; the form does not edit them.
      setMultiple({ ...signupData, avatarUrl: data.avatarUrl, fullName: data.fullName, username: data.username, occupation: data.occupation, gender: data.gender, dob: data.dateOfBirth instanceof Date ? data.dateOfBirth.toISOString() : data.dateOfBirth });
      setStep(3);
      router.push("/auth/signup/follow-someone");
    } catch (e) { addToast("Error saving", "error"); } finally { setIsLoading(false); }
  };

  return (
    <SafeAreaView style={styles.container}>
      {adjusterHost}
      <View style={styles.header}>
        <BackButton size={24} color="#000" style={styles.backButton} onPress={cancelSignup} />
        <Text style={styles.headerTitle}>Fill Your Profile</Text>
        <View style={{ width: 24 }} />
      </View>

      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        <View style={styles.avatarContainer}>
          <TouchableOpacity onPress={pickAvatar} style={styles.avatarWrapper} disabled={isUploading}>
             <Image source={localAvatarUri ? { uri: localAvatarUri } : Images.userLight} style={[styles.avatar, errors.avatarUrl && { borderColor: 'red', borderWidth: 2 }]} />
             {isUploading && <View style={styles.uploadOverlay}><CircularProgress progress={uploadProgress} size={80} /></View>}
             {!isUploading && (
                <View style={styles.editIconContainer}>
                    <Pencil_Icon width={16} height={16} fill="white" />
                </View>
             )}
          </TouchableOpacity>
          {canReadjust && !isUploading && (
            <TouchableOpacity onPress={handleReadjust} style={styles.adjustLink} accessibilityRole="button" accessibilityLabel="Adjust photo">
              <Text style={styles.adjustLinkText}>Adjust photo</Text>
            </TouchableOpacity>
          )}
        </View>

        <FormInput control={control} name="fullName" placeholder="Full Name" errorMessage={errors.fullName?.message} />
        
        <FormInput control={control} name="username" placeholder="Username" autoCapitalize="words" autoCorrect={false} errorMessage={errors.username?.message} rightIcon={usernameChecking ? <ActivityIndicator size="small" color="#ff4466" /> : null} />
        
        {showEmail ? (
          <FormInput control={control} name="email" placeholder="Email" rightIcon={<Email_Icon width={20} height={20} color="#9E9E9E" />} editable={false} style={styles.readOnlyInput} />
        ) : null}
        {showPhone ? (
          <FormInput control={control} name="phone" placeholder="Phone Number" editable={false} style={styles.readOnlyInput} />
        ) : null}
        <Text style={styles.verifyLaterNote}>
          {showPhone ? "Email" : "Mobile number"} aur verification baad mein Profile → Edit Profile se kar sakte hain.
        </Text>

        <TouchableOpacity style={[styles.dropdown, errors.gender && { borderColor: 'red' }]} onPress={() => setGenderPickerVisibility(true)}>
            <Text style={{ color: selectedGender ? '#000' : '#9E9E9E', fontFamily: 'Urbanist-Medium' }}>{selectedGender || "Gender"}</Text>
            <Ionicons name="chevron-down" size={20} color="#9E9E9E" />
        </TouchableOpacity>

        <TouchableOpacity style={[styles.dropdown, errors.occupation && { borderColor: 'red' }]} onPress={() => setOccupationPickerVisibility(true)}>
            <Text style={{ color: selectedOccupation ? '#000' : '#9E9E9E', fontFamily: 'Urbanist-Medium' }}>{selectedOccupation || "Occupation"}</Text>
            <Ionicons name="chevron-down" size={20} color="#9E9E9E" />
        </TouchableOpacity>

        <DatePickerField control={control} name="dateOfBirth" placeholder="Date of Birth" errorMessage={errors.dateOfBirth?.message as string | undefined} />

        {/* Optional referral code — pays both users once the friend qualifies
            (lib/referralProgram.ts). There is no signup bonus. */}
        {appConfig?.referral?.enabled !== false && (
        <>
        {referralOffer ? <Text style={styles.referralHint}>🎁 {referralOffer}</Text> : null}
        <TextInput
          value={signupData.referralCode || ''}
          onChangeText={(t) => setField('referralCode', t.trim().toUpperCase())}
          placeholder="Referral code (optional)"
          placeholderTextColor="#9E9E9E"
          autoCapitalize="characters"
          style={styles.referralInput}
        />
        </>
        )}

        <TouchableOpacity onPress={handleSubmit(onSubmit)} style={styles.continueButton} disabled={isLoading || isUploading || usernameChecking}>
          {isLoading ? <ActivityIndicator color="white" /> : <Text style={styles.continueButtonText}>Continue</Text>}
        </TouchableOpacity>
      </ScrollView>

      <ReanimatedBottomSheet visible={isGenderPickerVisible} onClose={() => setGenderPickerVisibility(false)} title="Select Gender" maxHeight={300}>
        <View style={{ paddingBottom: 20 }}>
            {['Male', 'Female', 'Other'].map((g) => (
                <TouchableOpacity key={g} style={styles.modalOption} onPress={() => { setValue('gender', g); trigger('gender'); setGenderPickerVisibility(false); }}>
                    <Text style={[styles.modalOptionText, selectedGender === g && { color: '#ff4466', fontWeight: 'bold' }]}>{g}</Text>
                    {selectedGender === g && <Ionicons name="checkmark" size={24} color="#ff4466" />}
                </TouchableOpacity>
            ))}
        </View>
      </ReanimatedBottomSheet>

      <ReanimatedBottomSheet visible={isOccupationPickerVisible} onClose={() => setOccupationPickerVisibility(false)} title="Select Occupation" maxHeight={500}>
        <ScrollView style={{ maxHeight: 400 }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
            {occupations.map((occ) => (
                <TouchableOpacity key={occ} style={styles.modalOption} onPress={() => { setValue('occupation', occ); trigger('occupation'); setOccupationPickerVisibility(false); }}>
                    <Text style={[styles.modalOptionText, selectedOccupation === occ && { color: '#ff4466', fontWeight: 'bold' }]}>{occ}</Text>
                    {selectedOccupation === occ && <Ionicons name="checkmark" size={24} color="#ff4466" />}
                </TouchableOpacity>
            ))}
        </ScrollView>
      </ReanimatedBottomSheet>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 20, paddingVertical: 10 },
  headerTitle: { fontSize: 20, fontFamily: "Urbanist-Bold" },
  backButton: { padding: 5 },
  scrollContent: { paddingHorizontal: 24, paddingBottom: 40 },
  avatarContainer: { alignItems: "center", marginVertical: 30 },
  adjustLink: { marginTop: 10, alignSelf: 'center', paddingVertical: 4, paddingHorizontal: 10 },
  adjustLinkText: { color: '#ff4466', fontSize: 13, fontFamily: 'Urbanist-Bold' },
  avatarWrapper: { position: "relative" },
  avatar: { width: 140, height: 140, borderRadius: 70, backgroundColor: '#F5F5F5' },
  uploadOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.4)', borderRadius: 70, justifyContent: 'center', alignItems: 'center' },
  editIconContainer: { position: 'absolute', bottom: 5, right: 5, backgroundColor: '#ff4466', borderRadius: 12, padding: 8, borderWidth: 3, borderColor: '#fff', width: 36, height: 36, justifyContent: 'center', alignItems: 'center', zIndex: 10 },
  phoneInputRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 20, gap: 12 },
  flagButton: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#FAFAFA', borderRadius: 12, paddingHorizontal: 12, height: 56, justifyContent: 'center', borderWidth: 1, borderColor: '#f0f0f0' },
  flagText: { fontSize: 16, fontFamily: "Urbanist-Medium" },
  phoneField: { flex: 1 },
  dropdown: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#FAFAFA', borderRadius: 12, paddingHorizontal: 16, height: 56, marginBottom: 20, borderWidth: 1, borderColor: '#f0f0f0' },
  referralHint: { fontFamily: 'Urbanist-SemiBold', fontSize: 13, color: '#ff4466', marginBottom: 8 },
  referralInput: { backgroundColor: '#FAFAFA', borderRadius: 12, paddingHorizontal: 16, height: 56, marginBottom: 20, borderWidth: 1, borderColor: '#f0f0f0', fontFamily: 'Urbanist-Medium', color: '#000' },
  continueButton: { backgroundColor: "#ff4466", paddingVertical: 18, borderRadius: 30, marginTop: 10 },
  continueButtonText: { color: "white", textAlign: "center", fontSize: 16, fontFamily: "Urbanist-Bold" },
  modalOption: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: '#F5F5F5', paddingHorizontal: 10 },
  modalOptionText: { fontSize: 18, fontFamily: 'Urbanist-SemiBold', color: '#424242' },
  readOnlyInput: { opacity: 0.6, backgroundColor: '#f0f0f0' },
  verifyLaterNote: { color: '#757575', fontSize: 13, fontFamily: 'Urbanist-Medium', marginTop: -8, marginBottom: 20 },
});

export default FillProfile;
