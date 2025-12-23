
import React, { createContext, useContext, useState, useCallback, ReactNode } from 'react';
import { View, Text, StyleSheet, Animated, Platform } from 'react-native';

interface ToastMessage {
  id: number;
  message: string;
  type: 'success' | 'error' | 'info';
}

interface AddToastOptions {
    text: string;
    type?: 'success' | 'error' | 'info';
}

// Support both string and object options for flexibility
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

interface ToastProviderProps {
    children: ReactNode;
}

export const ToastProvider: React.FC<ToastProviderProps> = ({ children }) => {
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
    setTimeout(() => {
      removeToast(id);
    }, 3000);
  }, []);

  const removeToast = (id: number) => {
    setToasts(currentToasts => currentToasts.filter(toast => toast.id !== id));
  };

  return (
    <ToastContext.Provider value={{ addToast }}>
      <View style={styles.rootContainer}>
        {children}
        <View style={styles.container} pointerEvents="box-none">
          {toasts.map(toast => (
            <Toast key={toast.id} message={toast.message} type={toast.type} onHide={() => removeToast(toast.id)} />
          ))}
        </View>
      </View>
    </ToastContext.Provider>
  );
};

interface ToastProps {
  message: string;
  type: 'success' | 'error' | 'info';
  onHide: () => void;
}

const Toast: React.FC<ToastProps> = ({ message, type, onHide }) => {
    const [fadeAnim] = useState(new Animated.Value(0));
  
    React.useEffect(() => {
      Animated.timing(fadeAnim, {
        toValue: 1,
        duration: 300,
        useNativeDriver: true,
      }).start(() => {
        setTimeout(() => {
            Animated.timing(fadeAnim, {
                toValue: 0,
                duration: 300,
                useNativeDriver: true
            }).start(onHide);
        }, 2400)
      });
    }, [fadeAnim, onHide]);
  
    const backgroundColor = {
      success: '#4CAF50',
      error: '#F44336',
      info: '#2196F3',
    }[type];
  
    return (
      <Animated.View style={[styles.toast, { backgroundColor, opacity: fadeAnim }]}>
        <Text style={styles.message}>{message}</Text>
      </Animated.View>
    );
  };
  

const styles = StyleSheet.create({
  rootContainer: {
    flex: 1,
  },
  container: {
    position: 'absolute',
    top: Platform.OS === 'web' ? 20 : 50,
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 9999,
  },
  toast: {
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 12,
    marginVertical: 5,
    minWidth: 200,
    maxWidth: '80%',
    elevation: 5,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 3.84,
  },
  message: {
    color: 'white',
    fontSize: 16,
    textAlign: 'center',
    fontWeight: '500',
  },
});
