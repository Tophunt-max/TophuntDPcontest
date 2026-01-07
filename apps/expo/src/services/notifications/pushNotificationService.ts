import { useState, useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { doc, setDoc } from 'firebase/firestore';
import { router } from 'expo-router';
import { auth, firestore } from '../../firebaseConfig';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

export async function registerForPushNotificationsAsync() {
  let token;

  if (Device.isDevice) {
    const { status: existingStatus } = await Notifications.getPermissionsAsync();
    let finalStatus = existingStatus;

    if (existingStatus !== 'granted') {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }

    if (finalStatus !== 'granted') {
      console.log('Failed to get push token for push notification!');
      return;
    }

    try {
      const expoPushToken = await Notifications.getExpoPushTokenAsync({
        projectId: process.env.EXPO_PUBLIC_PROJECT_ID,
      });
      token = expoPushToken.data;
      console.log('Expo Push Token:', token);
    } catch (e) {
      console.error('Expo Push Token generate karte waqt error:', e);
      return;
    }
  } else {
    console.log('Must use physical device for Push Notifications');
    return;
  }

  if (Platform.OS === 'android') {
    Notifications.setNotificationChannelAsync('default', {
      name: 'default',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: '#FF231F7C',
    });
  }

  if (token) {
    const userId = auth.currentUser?.uid;
    if (!userId) {
      console.log('User logged in nahi hai, token save nahi kar sakte.');
      return;
    }
    try {
      const userDocRef = doc(firestore, 'users', userId);
      await setDoc(userDocRef, { pushToken: token }, { merge: true });
      console.log('Push token successfully saved to Firestore for user:', userId);
    } catch (error) {
      console.error('Error saving push token to Firestore:', error);
    }
  }

  return token;
}

/**
 * Notification listeners ko manage karne ke liye ek custom hook.
 */
export const useNotificationObserver = () => {
  const [notification, setNotification] = useState<Notifications.Notification | null>(null);
  const notificationListener = useRef<Notifications.Subscription>();
  const responseListener = useRef<Notifications.Subscription>();

  useEffect(() => {
    // Web check: Web par notification listeners kaam nahi karte is tarah se
    if (Platform.OS === 'web') return;

    // 1. Jab app foreground mein ho aur notification aaye
    notificationListener.current = Notifications.addNotificationReceivedListener(notification => {
      setNotification(notification);
      console.log('Notification Received:', notification);
    });

    // 2. Jab user notification par tap kare
    responseListener.current = Notifications.addNotificationResponseReceivedListener(response => {
      console.log('Notification Response Received:', response);
      router.push('/notifications');
    });

    // Cleanup
    return () => {
      if (notificationListener.current && Notifications.removeNotificationSubscription) {
        Notifications.removeNotificationSubscription(notificationListener.current);
      }
      if (responseListener.current && Notifications.removeNotificationSubscription) {
        Notifications.removeNotificationSubscription(responseListener.current);
      }
    };
  }, []);

  return { notification };
};
