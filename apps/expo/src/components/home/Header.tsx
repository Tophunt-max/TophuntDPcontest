import React, { memo } from "react";
import {
  View,
  StyleSheet,
  Pressable,
  Image,
  Text,
} from 'react-native';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { 
    ChatIcon_Light, ChatIcon_Dark 
} from '@/assets/svgs';
import { useRouter } from 'expo-router';
import { Colors } from '@/constants/theme';
import { useAppConfig } from "@/src/services/appSettings";
import images from "@/assets/images";
import { HeartNotificationIcon } from "../notifications/HeartNotificationIcon";
import { useAuthGate } from '@/src/hooks/useAuthGate';
import { loginHref } from '@/src/lib/authGate';

const HeaderComponent = () => {
  const router = useRouter();
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  const { config } = useAppConfig();

  const ChatIcon = isDark ? ChatIcon_Dark : ChatIcon_Light;
  const { requireAuth, isGuest } = useAuthGate();

  return (
    <View
      style={[
        styles.container,
        { 
            backgroundColor: isDark ? Colors.dark.background : Colors.light.background,
            borderBottomColor: isDark ? '#35383F' : '#eaeaea',
            borderBottomWidth: StyleSheet.hairlineWidth,
        },
      ]}
    >
      {/* LEFT */}
      <View style={styles.left}>
        <Image 
          source={config?.headerLogoUrl ? { uri: config.headerLogoUrl } : images.tophuntLogo} 
          style={{ width: 115, height: 32 }} 
          resizeMode="contain" 
        />
      </View>

      {/* RIGHT */}
      {isGuest ? (
        // Guests have no notifications or inbox; Instagram shows "Log in" here.
        <View style={styles.right}>
          <Pressable
            hitSlop={8}
            style={styles.loginPill}
            onPress={() => router.push(loginHref('/home') as any)}
            accessibilityRole="button"
            accessibilityLabel="Log in"
          >
            <Text style={styles.loginText}>Log in</Text>
          </Pressable>
        </View>
      ) : (
      <View style={styles.right}>
        <View style={styles.iconBtn}>
           <HeartNotificationIcon />
        </View>

        <Pressable 
            hitSlop={10} 
            style={styles.iconBtn}
            onPress={() => requireAuth('message', { returnTo: '/messages' }) && router.push('/messages')}
        >
          <ChatIcon width={24} height={24} />
        </Pressable>
      </View>
      )}
    </View>
  );
};

export const Header = memo(HeaderComponent);

const styles = StyleSheet.create({
  container: {
    width: "100%",
    paddingLeft: 10,
    paddingRight: 16,
    height: 54,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  left: { 
      flexDirection: "row", 
      alignItems: "center",
      justifyContent: 'flex-start',
      flex: 1, 
  },
  right: { 
      flexDirection: "row",
      alignItems: 'center' 
  },
  iconBtn: { 
      marginLeft: 20 
  },
  loginPill: {
      minHeight: 34,
      paddingHorizontal: 16,
      borderRadius: 17,
      justifyContent: 'center',
      backgroundColor: '#FF4D67',
  },
  loginText: { color: '#FFF', fontFamily: 'Urbanist-Bold', fontSize: 14 },
});
