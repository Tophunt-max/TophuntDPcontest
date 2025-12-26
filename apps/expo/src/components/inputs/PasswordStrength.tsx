
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';

type PasswordStrengthProps = {
  password?: string;
};

const PasswordStrength: React.FC<PasswordStrengthProps> = ({ password }) => {
  const getStrength = () => {
    if (!password) return { strength: 0, color: '#FF4D67', label: '' };

    let score = 0;
    if (password.length >= 8) score++;
    if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score++;
    if (/\d/.test(password)) score++;
    if (/[^a-zA-Z0-9]/.test(password)) score++;

    switch (score) {
      case 0:
      case 1:
        return { strength: (score + 1) * 25, color: '#FF4D67', label: 'Weak' };
      case 2:
        return { strength: 50, color: '#FFA500', label: 'Medium' };
      case 3:
        return { strength: 75, color: '#FFFF00', label: 'Strong' };
      case 4:
        return { strength: 100, color: '#00FF00', label: 'Very Strong' };
      default:
        return { strength: 0, color: '#FF4D67', label: '' };
    }
  };

  const { strength, color, label } = getStrength();

  return (
    <View style={styles.container}>
      <View style={styles.strengthBar}>
        <View style={[styles.strengthIndicator, { width: `${strength}%`, backgroundColor: color }]} />
      </View>
      <Text style={[styles.strengthLabel, { color }]}>{label}</Text>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    marginTop: 8,
  },
  strengthBar: {
    height: 5,
    backgroundColor: '#eee',
    borderRadius: 2.5,
  },
  strengthIndicator: {
    height: '100%',
    borderRadius: 2.5,
  },
  strengthLabel: {
    marginTop: 4,
    fontSize: 12,
    fontFamily: 'Urbanist-SemiBold',
    textAlign: 'right',
  },
});

export default PasswordStrength;
