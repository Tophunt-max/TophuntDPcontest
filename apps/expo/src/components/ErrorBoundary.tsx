import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { reportError } from '@/src/lib/reportError';

interface Props {
  children: React.ReactNode;
}

interface State {
  hasError: boolean;
}

/**
 * App-wide error boundary. Catches render/lifecycle crashes anywhere below the
 * root so a single component failure shows a recoverable fallback instead of a
 * blank/white screen, and forwards the error to the central reporter.
 */
export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    reportError(error, { componentStack: info.componentStack });
  }

  handleReset = () => this.setState({ hasError: false });

  render() {
    if (this.state.hasError) {
      return (
        <View style={styles.container}>
          <Ionicons name="sad-outline" size={56} color="#FF4D67" style={styles.icon} />
          <Text style={styles.title}>Something went wrong</Text>
          <Text style={styles.subtitle}>
            An unexpected error occurred. You can try again — if it keeps
            happening, please restart the app.
          </Text>
          <TouchableOpacity style={styles.button} onPress={this.handleReset} activeOpacity={0.85}>
            <Text style={styles.buttonText}>Try Again</Text>
          </TouchableOpacity>
        </View>
      );
    }
    return this.props.children;
  }
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, backgroundColor: '#fff' },
  icon: { marginBottom: 16 },
  title: { fontSize: 20, fontFamily: 'Urbanist-Bold', color: '#121212', marginBottom: 8 },
  subtitle: { fontSize: 14, fontFamily: 'Urbanist-Medium', color: '#757575', textAlign: 'center', lineHeight: 20, marginBottom: 24 },
  button: { backgroundColor: '#FF4D67', paddingHorizontal: 32, paddingVertical: 14, borderRadius: 30 },
  buttonText: { color: '#fff', fontSize: 16, fontFamily: 'Urbanist-Bold' },
});
