import React, { createContext, useContext, useState, useCallback, ReactNode, useEffect, useRef } from 'react';
import { View, Text, StyleSheet, Animated, Platform, Dimensions } from 'react-native';

const { width } = Dimensions.get('window');

interface ToastMessage {
  id: number;
  message: string;
  type: 'success' | 'error' | 'info';
}

interface AddToastOptions {
    text: string;
    type?: 'success' | 'error' | 'info';
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

    if (typeof arg === 'string') {
        message = arg;
        type = typeArg || 'info';
    } else {
        message = arg.text;
        type = arg.type || typeArg || 'info';
    }

    setToasts(currentToasts => [...currentToasts, { id, message, type }]);
  }, []);

  const removeToast = useCallback((id: number) => {
    setToasts(currentToasts => currentToasts.filter(toast => toast.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ addToast }}>
      <View style={{ flex: 1 }}>
        {children}
        <View style={styles.container} pointerEvents="box-none">
          {toasts.map(toast => (
            <ToastItem key={toast.id} toast={toast} onHide={() => removeToast(toast.id)} />
          ))}
        </View>
      </View>
    </ToastContext.Provider>
  );
};

const ToastItem: React.FC<{ toast: ToastMessage; onHide: () => void }> = ({ toast, onHide }) => {
    const fadeAnim = useRef(new Animated.Value(0)).current;
    const slideAnim = useRef(new Animated.Value(-100)).current;
    const rotateAnim = useRef(new Animated.Value(0)).current;

    useEffect(() => {
        // Entrance animation: Pop and Slide
        Animated.parallel([
            Animated.timing(fadeAnim, { toValue: 1, duration: 400, useNativeDriver: true }),
            Animated.spring(slideAnim, { toValue: 0, tension: 50, friction: 7, useNativeDriver: true }),
            Animated.sequence([
                Animated.timing(rotateAnim, { toValue: 1, duration: 100, useNativeDriver: true }),
                Animated.timing(rotateAnim, { toValue: -1, duration: 200, useNativeDriver: true }),
                Animated.timing(rotateAnim, { toValue: 0, duration: 100, useNativeDriver: true }),
            ])
        ]).start();

        const timer = setTimeout(() => {
            Animated.parallel([
                Animated.timing(fadeAnim, { toValue: 0, duration: 400, useNativeDriver: true }),
                Animated.timing(slideAnim, { toValue: -100, duration: 400, useNativeDriver: true })
            ]).start(onHide);
        }, 2800);

        return () => clearTimeout(timer);
    }, []);

    const rotation = rotateAnim.interpolate({
        inputRange: [-1, 1],
        outputRange: ['-5deg', '5deg']
    });

    const getColors = () => {
        switch (toast.type) {
            case 'success': return ['#FF4D67', '#FF8A4D']; // Success with gradient feel
            case 'error': return ['#FF5252', '#FF1744'];
            default: return ['#448AFF', '#2979FF'];
        }
    };

    const colors = getColors();

    return (
        <Animated.View 
            style={[
                styles.toast, 
                { 
                    opacity: fadeAnim, 
                    transform: [
                        { translateY: slideAnim },
                        { rotate: rotation }
                    ],
                    backgroundColor: colors[0]
                }
            ]}
        >
            <View style={styles.content}>
                <Text style={styles.emoji}>{toast.type === 'success' ? '🔥' : toast.type === 'error' ? '💀' : '✨'}</Text>
                <Text style={styles.message}>{toast.message}</Text>
            </View>
        </Animated.View>
    );
};

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    top: Platform.OS === 'ios' ? 60 : 40,
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 9999,
  },
  toast: {
    paddingVertical: 14,
    paddingHorizontal: 20,
    borderRadius: 20,
    marginVertical: 6,
    width: width * 0.85,
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.3)',
    elevation: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 5 },
    shadowOpacity: 0.3,
    shadowRadius: 10,
  },
  content: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  emoji: {
    fontSize: 20,
    marginRight: 10,
  },
  message: {
    color: 'white',
    fontSize: 15,
    fontFamily: Platform.OS === 'ios' ? 'System' : 'Roboto',
    fontWeight: 'bold',
    textAlign: 'center',
    flexShrink: 1,
  },
});
