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
import React, { useState, useEffect } from "react";
import { router } from "expo-router";
import * as ImagePicker from "expo-image-picker";
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
import { CountryPicker } from "react-native-country-codes-picker";
import { useToast } from "@/src/components/toast/ToastProvider";
import Images from "@/assets/images";
import Svg, { Circle } from 'react-native-svg';
import { ReanimatedBottomSheet } from "@/src/components/modals/ReanimatedBottomSheet";
import { callApi } from "@/src/services/api"; // Centralized API Caller

const fillProfileSchema = z.object({
  avatarUrl: z.string().min(1, "Please upload a profile picture"),
  fullName: z.string().min(1, "Full name is required"),
  username: z.string()
    .min(1, "Username is required")
    .min(3, "Must be at least 3 characters")
    .regex(/^[a-zA-Z0-9_.]+$/, "Invalid format"),
  email: z.string().min(1, "Email is required").email("Invalid email"),
  // National subscriber number (without country code). Lengths vary by country,
  // so accept 6–14 digits instead of hardcoding India's 10. Combined with the
  // selected dial code this forms a valid E.164 number.
  phone: z
    .string()
    .min(1, "Phone required")
    .regex(/^\d{6,14}$/, "Enter a valid phone number"),
  occupation: z.string().min(1, "Required"),
  gender: z.string().min(1, "Required"),
  dateOfBirth: z.any().refine((val) => !!val, "Required"),
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
  const { addToast } = useToast();
  
  const [isGenderPickerVisible, setGenderPickerVisibility] = useState(false);
  const [isOccupationPickerVisible, setOccupationPickerVisibility] = useState(false);
  const [showCountryPicker, setShowCountryPicker] = useState(false);
  
  const isEmailLocked = signupData.authProvider !== 'phone' && !!signupData.email;
  const isPhoneLocked = signupData.authProvider === 'phone';

  const [countryCode, setCountryCode] = useState('+91');
  const [isLoading, setIsLoading] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [localAvatarUri, setLocalAvatarUri] = useState<string | null>(signupData.avatarUrl || null);
  
  const [usernameChecking, setUsernameChecking] = useState(false);
  const [phoneChecking, setPhoneChecking] = useState(false);

  const { control, handleSubmit, setValue, watch, trigger, setError, clearErrors, formState: { errors } } = useForm<FillProfileFormValues>({
    resolver: zodResolver(fillProfileSchema),
    defaultValues: {
      avatarUrl: signupData.avatarUrl || "",
      fullName: signupData.fullName || "",
      username: signupData.username || "",
      email: signupData.email || "",
      phone: signupData.phone?.replace(/^\+\d{2}/, '') || "",
      occupation: signupData.occupation || "",
      gender: signupData.gender || "",
      dateOfBirth: signupData.dob ? new Date(signupData.dob) : undefined,
    },
  });

  const selectedOccupation = watch("occupation");
  const selectedGender = watch("gender");
  const username = watch("username");
  const phone = watch("phone");

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

  // PHONE CHECK (Using New API Router)
  useEffect(() => {
    const checkPhone = async () => {
        if (phone && /^\d{6,14}$/.test(phone) && !isPhoneLocked) {
            setPhoneChecking(true);
            try {
                const result = await callApi('check', { type: 'phone', value: countryCode + phone });
                if (result.exists) {
                    setError("phone", { type: "manual", message: "This phone number is already registered!" });
                } else { clearErrors("phone"); }
            } catch (e) {} finally { setPhoneChecking(false); }
        }
    };
    const timer = setTimeout(checkPhone, 500);
    return () => clearTimeout(timer);
  }, [phone, countryCode, isPhoneLocked]);

  const pickAvatar = async () => {
    const img = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsEditing: true, aspect: [1, 1], quality: 0.5 });
    if (!img.canceled && img.assets) {
      const selectedImage = img.assets[0];
      setLocalAvatarUri(selectedImage.uri);
      // Defer the actual upload to the final step. During signup the account
      // (and its auth token) doesn't exist yet for email signups, so uploading
      // now would hit the authenticated /upload endpoint and 401 ("Upload
      // failed"). We keep the local URI and upload it in `congratulations`
      // once the account is created and the user is signed in.
      setValue("avatarUrl", selectedImage.uri);
      setField("avatarUrl", selectedImage.uri);
      trigger("avatarUrl");
    }
  };

  const onSubmit = async (data: FillProfileFormValues) => {
    if (usernameChecking || phoneChecking) return;
    setIsLoading(true);
    try {
      setMultiple({ ...signupData, avatarUrl: data.avatarUrl, fullName: data.fullName, username: data.username, email: data.email, phone: countryCode + data.phone, occupation: data.occupation, gender: data.gender, dob: data.dateOfBirth instanceof Date ? data.dateOfBirth.toISOString() : data.dateOfBirth });
      setStep(3);
      router.push("/auth/signup/follow-someone");
    } catch (e) { addToast("Error saving", "error"); } finally { setIsLoading(false); }
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <BackButton size={24} color="#000" style={styles.backButton} />
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
        </View>

        <FormInput control={control} name="fullName" placeholder="Full Name" errorMessage={errors.fullName?.message} />
        
        <FormInput control={control} name="username" placeholder="Username" errorMessage={errors.username?.message} rightIcon={usernameChecking ? <ActivityIndicator size="small" color="#ff4466" /> : null} />
        
        <FormInput control={control} name="email" placeholder="Email" rightIcon={<Email_Icon width={20} height={20} color="#9E9E9E" />} editable={!isEmailLocked} style={isEmailLocked ? styles.readOnlyInput : null} errorMessage={errors.email?.message} />

        <View style={styles.phoneInputRow}>
             <TouchableOpacity style={[styles.flagButton, isPhoneLocked && styles.readOnlyInput]} onPress={() => !isPhoneLocked && setShowCountryPicker(true)} disabled={isPhoneLocked}>
                <Text style={styles.flagText}>{countryCode}</Text>
                {!isPhoneLocked && <Ionicons name="chevron-down" size={14} color="#9E9E9E" style={{ marginLeft: 4 }} />}
             </TouchableOpacity>
             <View style={styles.phoneField}>
                 <FormInput control={control} name="phone" placeholder="Phone Number" containerStyle={{ marginBottom: 0 }} keyboardType="phone-pad" maxLength={14} editable={!isPhoneLocked} style={isPhoneLocked ? styles.readOnlyInput : null} errorMessage={errors.phone?.message} rightIcon={phoneChecking ? <ActivityIndicator size="small" color="#ff4466" /> : null} />
             </View>
        </View>

        <CountryPicker 
            lang="en"
            show={showCountryPicker} 
            pickerButtonOnPress={(item) => { setCountryCode(item.dial_code); setShowCountryPicker(false); }} 
            onBackdropPress={() => setShowCountryPicker(false)} 
            style={{ modal: { height: 500 } }} 
        />

        <TouchableOpacity style={[styles.dropdown, errors.gender && { borderColor: 'red' }]} onPress={() => setGenderPickerVisibility(true)}>
            <Text style={{ color: selectedGender ? '#000' : '#9E9E9E', fontFamily: 'Urbanist-Medium' }}>{selectedGender || "Gender"}</Text>
            <Ionicons name="chevron-down" size={20} color="#9E9E9E" />
        </TouchableOpacity>

        <TouchableOpacity style={[styles.dropdown, errors.occupation && { borderColor: 'red' }]} onPress={() => setOccupationPickerVisibility(true)}>
            <Text style={{ color: selectedOccupation ? '#000' : '#9E9E9E', fontFamily: 'Urbanist-Medium' }}>{selectedOccupation || "Occupation"}</Text>
            <Ionicons name="chevron-down" size={20} color="#9E9E9E" />
        </TouchableOpacity>

        <DatePickerField control={control} name="dateOfBirth" placeholder="Date of Birth" errorMessage={errors.dateOfBirth?.message as string | undefined} />

        {/* Optional referral code — credits both users on signup. */}
        <TextInput
          value={signupData.referralCode || ''}
          onChangeText={(t) => setField('referralCode', t.trim().toUpperCase())}
          placeholder="Referral code (optional)"
          placeholderTextColor="#9E9E9E"
          autoCapitalize="characters"
          style={styles.referralInput}
        />

        <TouchableOpacity onPress={handleSubmit(onSubmit)} style={styles.continueButton} disabled={isLoading || isUploading || usernameChecking || phoneChecking}>
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
  avatarWrapper: { position: "relative" },
  avatar: { width: 140, height: 140, borderRadius: 70, backgroundColor: '#F5F5F5' },
  uploadOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.4)', borderRadius: 70, justifyContent: 'center', alignItems: 'center' },
  editIconContainer: { position: 'absolute', bottom: 5, right: 5, backgroundColor: '#ff4466', borderRadius: 12, padding: 8, borderWidth: 3, borderColor: '#fff', width: 36, height: 36, justifyContent: 'center', alignItems: 'center', zIndex: 10 },
  phoneInputRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 20, gap: 12 },
  flagButton: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#FAFAFA', borderRadius: 12, paddingHorizontal: 12, height: 56, justifyContent: 'center', borderWidth: 1, borderColor: '#f0f0f0' },
  flagText: { fontSize: 16, fontFamily: "Urbanist-Medium" },
  phoneField: { flex: 1 },
  dropdown: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#FAFAFA', borderRadius: 12, paddingHorizontal: 16, height: 56, marginBottom: 20, borderWidth: 1, borderColor: '#f0f0f0' },
  referralInput: { backgroundColor: '#FAFAFA', borderRadius: 12, paddingHorizontal: 16, height: 56, marginBottom: 20, borderWidth: 1, borderColor: '#f0f0f0', fontFamily: 'Urbanist-Medium', color: '#000' },
  continueButton: { backgroundColor: "#ff4466", paddingVertical: 18, borderRadius: 30, marginTop: 10 },
  continueButtonText: { color: "white", textAlign: "center", fontSize: 16, fontFamily: "Urbanist-Bold" },
  modalOption: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: '#F5F5F5', paddingHorizontal: 10 },
  modalOptionText: { fontSize: 18, fontFamily: 'Urbanist-SemiBold', color: '#424242' },
  readOnlyInput: { opacity: 0.6, backgroundColor: '#f0f0f0' },
});

export default FillProfile;
