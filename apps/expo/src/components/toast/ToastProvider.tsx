import React, { createContext, useContext, useState, useCallback, ReactNode, useEffect } from 'react';
import { View, Text, StyleSheet, Platform, Dimensions } from 'react-native';
import Animated, { 
    FadeInUp, 
    FadeOutUp, 
    runOnJS 
} from 'react-native-reanimated';

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

  const removeToast = useCallback((id: number) => {
    setToasts(currentToasts => currentToasts.filter(toast => toast.id !== id));
  }, []);

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

    // Limit to 3 toasts max to prevent stacking lag
    setToasts(currentToasts => {
        const newToasts = [...currentToasts, { id, message, type }];
        if (newToasts.length > 3) {
            return newToasts.slice(newToasts.length - 3);
        }
        return newToasts;
    });

    // Auto remove after 2000ms (faster dismissal)
    setTimeout(() => {
        removeToast(id);
    }, 2000);
  }, [removeToast]);

  return (
    <ToastContext.Provider value={{ addToast }}>
      <View style={{ flex: 1 }}>
        {children}
        <View style={styles.container} pointerEvents="box-none">
          {toasts.map(toast => (
            <ToastItem key={toast.id} toast={toast} />
          ))}
        </View>
      </View>
    </ToastContext.Provider>
  );
};

const ToastItem = React.memo(({ toast }: { toast: ToastMessage }) => {
    const getColors = () => {
        switch (toast.type) {
            case 'success': return '#FF4D67'; 
            case 'error': return '#FF5252';
            default: return '#448AFF';
        }
    };

    const bgColor = getColors();

    return (
        <Animated.View 
            entering={FadeInUp.duration(300).springify()}
            exiting={FadeOutUp.duration(200)}
            style={[
                styles.toast, 
                { backgroundColor: bgColor }
            ]}
        >
            <View style={styles.content}>
                <Text style={styles.emoji}>{toast.type === 'success' ? '🔥' : toast.type === 'error' ? '💀' : '✨'}</Text>
                <Text style={styles.message}>{toast.message}</Text>
            </View>
        </Animated.View>
    );
});

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    top: Platform.OS === 'ios' ? 50 : 30, // Slightly higher
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 9999,
  },
  toast: {
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 25,
    marginVertical: 4,
    maxWidth: width * 0.9,
    minWidth: width * 0.4,
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.4)',
    elevation: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 8,
  },
  content: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  emoji: {
    fontSize: 18,
    marginRight: 8,
  },
  message: {
    color: 'white',
    fontSize: 14,
    fontFamily: Platform.OS === 'ios' ? 'System' : 'Roboto',
    fontWeight: '700',
    textAlign: 'center',
  },
});
