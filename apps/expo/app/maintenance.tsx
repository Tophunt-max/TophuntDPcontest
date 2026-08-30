import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  SafeAreaView,
  ScrollView,
  TouchableOpacity,
} from 'react-native';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { Colors } from '@/constants/theme';
import { Ionicons } from '@/src/lib/icons';
import { useAppConfig } from '@/src/services/appSettings';
import { PHONE_MAX_WIDTH } from '@/src/lib/layout';

export default function MaintenanceScreen() {
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  const { config } = useAppConfig();

  const backgroundColor = isDark ? Colors.dark.background : Colors.light.background;
  const textColor = isDark ? '#FFFFFF' : '#212121';

  return (
    <SafeAreaView style={[styles.container, { backgroundColor }]}>
      {/*
        Scrollable: the maintenance message is admin-editable, so its length is not
        known here. A long one pushed the centred content past a short window and
        was clipped at both ends, hiding the very explanation this screen exists
        to give.
      */}
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.iconContainer}>
          <Ionicons name="construct-outline" size={100} color="#FF4D67" />
        </View>
        
        <Text style={[styles.title, { color: textColor }]}>Under Maintenance</Text>
        
        <Text style={[styles.description, { color: isDark ? '#BDBDBD' : '#616161' }]}>
          {config?.maintenanceMessage?.trim() ||
            "We are currently performing scheduled maintenance to improve our services. We'll be back shortly!"}
        </Text>

        <View style={styles.infoCard}>
           <Text style={styles.infoText}>
             Please check back later. Thank you for your patience!
           </Text>
        </View>

        {/* This button is just for UI, since the app will auto-redirect when maintenance is OFF */}
        <TouchableOpacity 
          style={styles.refreshButton}
          onPress={() => {
            // Optional: Manual check trigger if needed
          }}
        >
          <Text style={styles.refreshText}>Check Again</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    // flexGrow, not flex — inside a ScrollView `flex: 1` sets `flex-basis: 0`,
    // collapsing the content box back to the viewport and re-clipping the content.
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 30,
    paddingVertical: 24,
    // Caps the card and button at phone width on a desktop window; no-op on phones.
    width: '100%',
    maxWidth: PHONE_MAX_WIDTH,
    alignSelf: 'center',
  },
  iconContainer: {
    marginBottom: 30,
    backgroundColor: '#FF4D6715',
    padding: 30,
    borderRadius: 100,
  },
  title: {
    fontSize: 28,
    fontFamily: 'Urbanist-Bold',
    marginBottom: 16,
    textAlign: 'center',
  },
  description: {
    fontSize: 16,
    fontFamily: 'Urbanist-Regular',
    textAlign: 'center',
    lineHeight: 24,
    marginBottom: 30,
  },
  infoCard: {
    backgroundColor: '#FF4D6710',
    padding: 20,
    borderRadius: 15,
    borderWidth: 1,
    borderColor: '#FF4D6730',
    width: '100%',
  },
  infoText: {
    color: '#FF4D67',
    fontFamily: 'Urbanist-Medium',
    textAlign: 'center',
    fontSize: 14,
  },
  refreshButton: {
    marginTop: 40,
    paddingVertical: 12,
    paddingHorizontal: 30,
    borderRadius: 100,
    backgroundColor: '#FF4D67',
  },
  refreshText: {
    color: '#FFF',
    fontFamily: 'Urbanist-Bold',
    fontSize: 16,
  }
});
