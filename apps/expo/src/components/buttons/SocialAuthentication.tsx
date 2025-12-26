import React from 'react';
import { View, TouchableOpacity, StyleSheet, Alert } from 'react-native';
import { Facebook_Icon, Google_Icon, Apple_Light, Apple_Dark } from '@/assets/svgs';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { useToast } from '@/src/components/toast/ToastProvider';
import { auth } from '@/src/services/firebase/initFirebase';
import { FacebookAuthProvider, signInWithCredential } from 'firebase/auth';
import * as Facebook from 'expo-facebook';
import { useRouter } from 'expo-router';

interface SocialAuthenticationProps {
  setIsLoading: (isLoading: boolean) => void;
}

export const SocialAuthentication: React.FC<SocialAuthenticationProps> = ({ setIsLoading }) => {
  const colorScheme = useColorScheme();
  const { addToast } = useToast();
  const router = useRouter();

  const handleSocialLogin = async (providerName: string) => {
    setIsLoading(true);

    if (providerName === 'Facebook') {
      try {
        await Facebook.initializeAsync({ appId: '<YOUR_APP_ID>' });
        const result = await Facebook.logInWithReadPermissionsAsync({
          permissions: ['public_profile', 'email'],
        });

        if (result.type === 'success') {
          const { token } = result;
          const credential = FacebookAuthProvider.credential(token);
          const userCredential = await signInWithCredential(auth, credential);
          addToast(`Signed in as ${userCredential.user.displayName}`, 'success');
          router.push('/home');
        } else {
          addToast('Facebook login cancelled.', 'warning');
        }
      } catch (error: any) {
        console.error('Facebook login error', error);
        Alert.alert('Facebook Login Error', error.message);
        addToast('An error occurred during Facebook login.', 'error');
      } finally {
        setIsLoading(false);
      }
    } else {
      addToast(`${providerName} login is not implemented yet.`, 'info');
      setIsLoading(false);
    }
  };

  return (
    <View style={styles.socialButtonsContainer}>
      <TouchableOpacity
        style={styles.socialIcon}
        onPress={() => handleSocialLogin('Facebook')}
      >
        <Facebook_Icon width={24} height={24} />
      </TouchableOpacity>

      <TouchableOpacity
        style={styles.socialIcon}
        onPress={() => handleSocialLogin('Google')}
      >
        <Google_Icon width={24} height={24} />
      </TouchableOpacity>

      <TouchableOpacity
        style={styles.socialIcon}
        onPress={() => handleSocialLogin('Apple')}
      >
        {colorScheme === 'dark' ? (
          <Apple_Light width={24} height={24} />
        ) : (
          <Apple_Dark width={24} height={24} />
        )}
      </TouchableOpacity>
    </View>
  );
};

const styles = StyleSheet.create({
  socialButtonsContainer: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 16,
    marginBottom: 20,
  },
  socialIcon: {
    width: 50,
    height: 50,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#eee',
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#fff',
  },
});
