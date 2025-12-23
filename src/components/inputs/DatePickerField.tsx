import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Modal } from 'react-native';
import { Control, Controller, FieldValues, Path } from 'react-hook-form';
import DateTimePicker from 'react-native-ui-datepicker';
import dayjs from 'dayjs';
import { Ionicons } from '@expo/vector-icons';

interface DatePickerFieldProps<T extends FieldValues> {
  control: Control<T>;
  name: Path<T>;
  placeholder: string;
  containerStyle?: any;
}

export const DatePickerField = <T extends FieldValues>({
  control,
  name,
  placeholder,
  containerStyle,
}: DatePickerFieldProps<T>) => {
  const [isDatePickerVisible, setDatePickerVisibility] = useState(false);

  return (
    <View style={[styles.container, containerStyle]}>
      <Controller
        control={control}
        name={name}
        render={({ field: { onChange, value }, fieldState: { error } }) => (
          <>
            <TouchableOpacity
              onPress={() => setDatePickerVisibility(true)}
              style={[
                styles.inputWrapper,
                { borderColor: error ? 'red' : 'transparent', borderWidth: error ? 1 : 0 }
              ]}
            >
              <Text style={[styles.text, !value && styles.placeholder]}>
                {value ? dayjs(value).format('DD/MM/YYYY') : placeholder}
              </Text>
              <Ionicons name="calendar-outline" size={20} color="#9E9E9E" />
            </TouchableOpacity>

            <Modal
              visible={isDatePickerVisible}
              transparent={true}
              animationType="fade"
              onRequestClose={() => setDatePickerVisibility(false)}
            >
              <View style={styles.modalOverlay}>
                <View style={styles.modalContent}>
                  <DateTimePicker
                    mode="single"
                    date={value}
                    onChange={(params) => {
                      onChange(params.date);
                      setDatePickerVisibility(false);
                    }}
                    selectedItemColor="#ff4466"
                  />
                  <TouchableOpacity
                    onPress={() => setDatePickerVisibility(false)}
                    style={styles.closeButton}
                  >
                    <Text style={styles.closeButtonText}>Close</Text>
                  </TouchableOpacity>
                </View>
              </View>
            </Modal>
            
            {error && <Text style={styles.errorText}>{error.message}</Text>}
          </>
        )}
      />
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    marginBottom: 20,
    width: '100%',
  },
  inputWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    height: 56,
    borderRadius: 12,
    paddingHorizontal: 16,
    backgroundColor: '#FAFAFA',
  },
  text: {
    fontSize: 16,
    color: '#000',
  },
  placeholder: {
    color: '#9E9E9E',
  },
  errorText: {
    color: 'red',
    fontSize: 12,
    marginTop: 4,
    marginLeft: 4,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  modalContent: {
    backgroundColor: 'white',
    borderRadius: 20,
    padding: 20,
    width: '100%',
    maxWidth: 400,
  },
  closeButton: {
    marginTop: 10,
    alignItems: 'center',
    padding: 10,
  },
  closeButtonText: {
    color: '#ff4466',
    fontWeight: 'bold',
  }
});
