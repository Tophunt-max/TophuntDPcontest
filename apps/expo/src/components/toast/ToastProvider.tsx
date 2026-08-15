import React, { createContext, useContext, useState, useCallback, ReactNode, useEffect, useRef } from 'react';
import { View, Text, StyleSheet, Animated, Platform, Dimensions, Image, ImageSourcePropType } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { setToastHandler } from '@/src/lib/toastBridge';

const { width } = Dimensions.get('window');

// Brand image shown in every toast popup by default. Callers can override it
// per-toast (e.g. a user avatar) via addToast({ text, image }).
const DEFAULT_TOAST_IMAGE: ImageSourcePropType = require('@/assets/images/Tophunt.png');

interface ToastMessage {
  id: number;
  message: string;
  type: 'success' | 'error' | 'info';
  image?: ImageSourcePropType;
}

interface AddToastOptions {
    text: string;
    type?: 'success' | 'error' | 'info';
    image?: ImageSourcePropType;
}

type AddToastArg = string | AddToastOptions;

interface ToastContextType {
  addToast: (arg: AddToastArg, type?: 'success' | 'error' | 'info') => void;
}

const ToastContext = createContext<ToastContextType | undefined>(undefined);

export const useToast = () => {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return context;
};

export const ToastProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  const addToast = useCallback((arg: AddToastArg, typeArg?: 'success' | 'error' | 'info') => {
    const id = Date.now();
    let message = '';
    let type: 'success' | 'error' | 'info' = 'info';
    let image: ImageSourcePropType | undefined;

    if (typeof arg === 'string') {
        message = arg;
        type = typeArg || 'info';
    } else {
        message = arg.text;
        type = arg.type || typeArg || 'info';
        image = arg.image;
    }

    setToasts(currentToasts => [...currentToasts, { id, message, type, image }]);
  }, []);

  const removeToast = useCallback((id: number) => {
    setToasts(currentToasts => currentToasts.filter(toast => toast.id !== id));
  }, []);

  // Expose addToast to non-React callers (React Query error handlers, etc.).
  useEffect(() => {
    setToastHandler((message, type) => addToast(message, type));
    return () => setToastHandler(null);
  }, [addToast]);

  const hasToasts = toasts.length > 0;

  return (
    <ToastContext.Provider value={{ addToast }}>
      <View style={{ flex: 1 }}>
        {children}
        {/* Centered popup overlay. pointerEvents="none" so transient toasts
            never block interaction with the app underneath. */}
        {hasToasts && (
          <View style={styles.overlay} pointerEvents="none">
            {toasts.map(toast => (
              <ToastItem key={toast.id} toast={toast} onHide={() => removeToast(toast.id)} />
            ))}
          </View>
        )}
      </View>
    </ToastContext.Provider>
  );
};

const TYPE_META: Record<ToastMessage['type'], { colors: [string, string]; emoji: string }> = {
  success: { colors: ['#FF4D67', '#FF8A4D'], emoji: '✅' },
  error: { colors: ['#FF5252', '#FF1744'], emoji: '⚠️' },
  info: { colors: ['#448AFF', '#2979FF'], emoji: 'ℹ️' },
};

const ToastItem: React.FC<{ toast: ToastMessage; onHide: () => void }> = ({ toast, onHide }) => {
    const scaleAnim = useRef(new Animated.Value(0.8)).current;
    const fadeAnim = useRef(new Animated.Value(0)).current;

    useEffect(() => {
        // Pop in — scale up + fade.
        Animated.parallel([
            Animated.spring(scaleAnim, { toValue: 1, tension: 80, friction: 8, useNativeDriver: true }),
            Animated.timing(fadeAnim, { toValue: 1, duration: 220, useNativeDriver: true }),
        ]).start();

        const timer = setTimeout(() => {
            Animated.parallel([
                Animated.timing(scaleAnim, { toValue: 0.9, duration: 250, useNativeDriver: true }),
                Animated.timing(fadeAnim, { toValue: 0, duration: 250, useNativeDriver: true }),
            ]).start(onHide);
        }, 2600);

        return () => clearTimeout(timer);
    }, []);

    const meta = TYPE_META[toast.type] || TYPE_META.info;

    return (
        <Animated.View
            style={[
                styles.cardWrapper,
                { opacity: fadeAnim, transform: [{ scale: scaleAnim }] },
            ]}
        >
            <LinearGradient
                colors={meta.colors}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={styles.card}
            >
                {/* Custom image (brand logo by default) with a small status badge. */}
                <View style={styles.imageCircle}>
                    <Image
                        source={toast.image || DEFAULT_TOAST_IMAGE}
                        style={styles.image}
                        resizeMode="contain"
                    />
                    <View style={styles.badge}>
                        <Text style={styles.badgeEmoji}>{meta.emoji}</Text>
                    </View>
                </View>
                <Text style={styles.message}>{toast.message}</Text>
            </LinearGradient>
        </Animated.View>
    );
};

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    zIndex: 9999,
  },
  cardWrapper: {
    marginVertical: 8,
  },
  card: {
    minWidth: width * 0.6,
    maxWidth: width * 0.82,
    paddingVertical: 24,
    paddingHorizontal: 26,
    borderRadius: 26,
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.25)',
    elevation: 14,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.35,
    shadowRadius: 20,
  },
  imageCircle: {
    width: 66,
    height: 66,
    borderRadius: 33,
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 14,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 4,
  },
  image: {
    width: 44,
    height: 44,
    borderRadius: 22,
  },
  badge: {
    position: 'absolute',
    bottom: -2,
    right: -2,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.2,
    shadowRadius: 2,
  },
  badgeEmoji: {
    fontSize: 13,
  },
  message: {
    color: 'white',
    fontSize: 16,
    fontFamily: Platform.OS === 'ios' ? 'System' : 'Roboto',
    fontWeight: 'bold',
    textAlign: 'center',
    lineHeight: 22,
  },
});
