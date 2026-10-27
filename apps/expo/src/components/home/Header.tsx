import React, { memo, useEffect, useState } from "react";
import {
  View,
  StyleSheet,
  Pressable,
  Image,
  Text,
} from 'react-native';
import { AppImage } from '@/src/components/ui/AppImage';
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
import { fitArt, useDesignWindow } from '@/src/lib/layout';

/**
 * Width / height of a remote image, or null until known (or when it fails).
 * Clamped to 1:1 .. 6:1 so a broken or extreme upload cannot squash the bar.
 */
function useImageAspect(uri: string | null): number | null {
  const [aspect, setAspect] = useState<{ uri: string; value: number } | null>(null);
  useEffect(() => {
    if (!uri) return;
    let alive = true;
    Image.getSize(
      uri,
      (w, h) => {
        if (alive && w > 0 && h > 0) setAspect({ uri, value: Math.min(Math.max(w / h, 1), 6) });
      },
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [uri]);
  return uri && aspect?.uri === uri ? aspect.value : null;
}

const HeaderComponent = () => {
  const router = useRouter();
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  const { config } = useAppConfig();

  const ChatIcon = isDark ? ChatIcon_Dark : ChatIcon_Light;
  const { requireAuth, isGuest } = useAuthGate();
  // Tophunt.webp is a 3:1 wordmark. The old 115x32 box (3.6:1) drew it at only
  // ~96x32. Now: up to 36% of the screen width, never taller than 44 so it stays
  // inside the 54px bar. Small phones scale down, larger screens stop at 132x44.
  // An admin `headerLogoUrl` may have any shape, so its real aspect ratio is read
  // first; a wider logo then gets a wider box instead of empty space around it.
  const { width: screenWidth } = useDesignWindow();
  const customUrl = config?.headerLogoUrl || null;
  const aspect = useImageAspect(customUrl) ?? 3;
  const logo = fitArt({ aspect, maxWidth: screenWidth * 0.36, maxHeight: 44 });

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
        <AppImage 
          source={config?.headerLogoUrl ? { uri: config.headerLogoUrl } : images.tophuntLogo} 
          displayWidth={logo.width}
          style={logo} 
          contentFit="contain" 
          transition={0}
          accessibilityLabel="TopHunt"
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
