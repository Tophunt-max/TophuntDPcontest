import React from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
} from 'react-native';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { Ionicons } from '@/src/lib/icons';

type IconName = string;

interface StateProps {
  icon?: IconName;
  title: string;
  subtitle?: string;
  actionLabel?: string;
  onAction?: () => void;
}

function BaseState({ icon, title, subtitle, actionLabel, onAction, accent }: StateProps & { accent: string }) {
  const isDark = useColorScheme() === 'dark';
  const textColor = isDark ? '#FFFFFF' : '#121212';
  const subColor = isDark ? '#8E9099' : '#8A8A8E';
  const circleBg = isDark ? '#1C1D25' : '#F0F1F5';

  return (
    <View style={styles.container}>
      {icon && (
        <View style={[styles.iconCircle, { backgroundColor: circleBg }]}>
          <Ionicons name={icon} size={34} color={accent} />
        </View>
      )}
      <Text style={[styles.title, { color: textColor }]}>{title}</Text>
      {subtitle ? <Text style={[styles.subtitle, { color: subColor }]}>{subtitle}</Text> : null}
      {actionLabel && onAction ? (
        <TouchableOpacity style={[styles.button, { backgroundColor: accent }]} onPress={onAction} activeOpacity={0.85}>
          <Text style={styles.buttonText}>{actionLabel}</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

/** Neutral "nothing here yet" placeholder. */
export function EmptyState(props: StateProps) {
  return <BaseState {...props} icon={props.icon ?? 'file-tray-outline'} accent="#8A8A8E" />;
}

/** Error placeholder with an optional retry button. */
export function ErrorState({
  title = 'Something went wrong',
  subtitle = "We couldn't load this. Please check your connection and try again.",
  actionLabel = 'Retry',
  onAction,
  icon = 'cloud-offline-outline',
}: Partial<StateProps>) {
  return (
    <BaseState
      icon={icon}
      title={title}
      subtitle={subtitle}
      actionLabel={onAction ? actionLabel : undefined}
      onAction={onAction}
      accent="#FF4D67"
    />
  );
}

const styles = StyleSheet.create({
  container: { alignItems: 'center', justifyContent: 'center', paddingVertical: 48, paddingHorizontal: 32 },
  iconCircle: { width: 72, height: 72, borderRadius: 36, alignItems: 'center', justifyContent: 'center', marginBottom: 16 },
  title: { fontSize: 17, fontFamily: 'Urbanist-Bold', textAlign: 'center', marginBottom: 6 },
  subtitle: { fontSize: 14, fontFamily: 'Urbanist-Medium', textAlign: 'center', lineHeight: 20, marginBottom: 18 },
  button: { paddingHorizontal: 28, paddingVertical: 12, borderRadius: 24 },
  buttonText: { color: '#FFF', fontSize: 14, fontFamily: 'Urbanist-Bold' },
});
