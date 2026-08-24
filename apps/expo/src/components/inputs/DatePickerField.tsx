import React, { useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Modal,
  Dimensions,
  Platform,
  Pressable,
} from 'react-native';
import { Control, Controller, FieldValues, Path } from 'react-hook-form';
import DateTimePickerBase from 'react-native-ui-datepicker';
import dayjs from 'dayjs';
import { Ionicons } from '@/src/lib/icons';
import { ArrowIcon } from '@/src/components/ui/ArrowIcon';
import { CloseIcon } from '@/src/components/ui/CloseIcon';

// The lib's prop union is over-strict for our single-date usage; alias as any.
const DateTimePicker = DateTimePickerBase as unknown as React.ComponentType<any>;

const { width: SCREEN_WIDTH } = Dimensions.get('window');

interface DatePickerFieldProps<T extends FieldValues> {
  control: Control<T>;
  name: Path<T>;
  placeholder: string;
  containerStyle?: any;
  errorMessage?: string;
}

export const DatePickerField = <T extends FieldValues>({
  control,
  name,
  placeholder,
  containerStyle,
  errorMessage,
}: DatePickerFieldProps<T>) => {
  const [isDatePickerVisible, setDatePickerVisibility] = useState(false);

  const getDefaultDate = () => {
    const d = new Date();
    d.setFullYear(d.getFullYear() - 18);
    return d;
  };

  return (
    <View style={[styles.container, containerStyle]}>
      <Controller
        control={control}
        name={name}
        render={({ field: { onChange, value }, fieldState: { error } }) => {
          const hasError = !!(error || errorMessage);
          
          return (
            <>
              <TouchableOpacity
                onPress={() => setDatePickerVisibility(true)}
                activeOpacity={0.7}
                style={[
                  styles.inputWrapper,
                  isDatePickerVisible && styles.focusedInput,
                  hasError && styles.errorInput
                ]}
              >
                <View style={styles.contentRow}>
                   <View style={styles.textContainer}>
                      <Text style={[styles.label, (value || isDatePickerVisible) && styles.labelActive]}>
                        {placeholder}
                      </Text>
                      <Text style={[styles.text, !value && styles.placeholder]}>
                        {value ? dayjs(value).format('DD MMM, YYYY') : "Select Birthday"}
                      </Text>
                   </View>
                   <View style={[styles.iconCircle, isDatePickerVisible && styles.iconCircleActive]}>
                      <Ionicons 
                        name="calendar" 
                        size={18} 
                        color={isDatePickerVisible ? '#fff' : '#9E9E9E'} 
                      />
                   </View>
                </View>
              </TouchableOpacity>

              <Modal
                visible={isDatePickerVisible}
                transparent={true}
                animationType="fade"
                onRequestClose={() => setDatePickerVisibility(false)}
              >
                <View style={styles.modalOverlay}>
                  <Pressable style={styles.backdrop} onPress={() => setDatePickerVisibility(false)} />
                  
                  <View style={styles.centeredPopup}>
                    <View style={styles.popupHeader}>
                      <Text style={styles.popupTitle}>{placeholder}</Text>
                      <TouchableOpacity 
                        onPress={() => setDatePickerVisibility(false)}
                        style={styles.closeBtn}
                      >
                        <CloseIcon size={20} color="#212121" />
                      </TouchableOpacity>
                    </View>

                    <View style={styles.pickerWrapper}>
                      <DateTimePicker
                        mode="single"
                        date={value ? new Date(value) : getDefaultDate()}
                        onChange={(params: any) => {
                          if (params.date) {
                            onChange(new Date(params.date as any));
                            // Auto close after selection with a small delay for feedback
                            setTimeout(() => {
                                setDatePickerVisibility(false);
                            }, 300);
                          }
                        }}
                        selectedItemColor="#ff4466"
                        calendarTextStyle={styles.calendarText}
                        headerTextStyle={styles.calendarHeader}
                        weekdayTextStyle={styles.weekdayText}
                        headerButtonStyle={styles.headerButton}
                        controlsProps={{
                          prevIcon: <ArrowIcon size={16} color="#212121" direction="left" />,
                          nextIcon: <ArrowIcon size={16} color="#212121" direction="right" />,
                        }}
                      />
                    </View>
                  </View>
                </View>
              </Modal>
              
              {hasError && (
                <Text style={styles.errorText}>
                  {error?.message || errorMessage}
                </Text>
              )}
            </>
          );
        }}
      />
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    marginBottom: 16,
    width: '100%',
  },
  inputWrapper: {
    height: 54,
    borderRadius: 12,
    paddingHorizontal: 16,
    backgroundColor: '#FAFAFA',
    borderWidth: 1,
    borderColor: '#eee',
    justifyContent: 'center',
  },
  focusedInput: {
    borderColor: '#ff4466',
    backgroundColor: '#FFF9FA',
  },
  errorInput: {
    borderColor: '#FF5252',
    backgroundColor: '#FFF8F8',
  },
  contentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  textContainer: {
    flex: 1,
  },
  label: {
    fontSize: 9,
    fontFamily: 'Urbanist-Bold',
    color: '#ff4466',
    marginBottom: -3,
    opacity: 0,
  },
  labelActive: {
    opacity: 1,
  },
  text: {
    fontSize: 14,
    color: '#212121',
    fontFamily: 'Urbanist-SemiBold',
  },
  placeholder: {
    color: '#9E9E9E',
  },
  iconCircle: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: '#F5F5F5',
    justifyContent: 'center',
    alignItems: 'center',
  },
  iconCircleActive: {
    backgroundColor: '#ff4466',
  },
  errorText: {
    color: '#FF5252',
    fontSize: 11,
    marginTop: 4,
    marginLeft: 4,
    fontFamily: 'Urbanist-Medium',
  },
  modalOverlay: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.5)',
    padding: 24,
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
  },
  centeredPopup: {
    backgroundColor: 'white',
    borderRadius: 20,
    width: Platform.OS === 'web' ? 320 : SCREEN_WIDTH - 64,
    maxWidth: 350,
    overflow: 'hidden',
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 12,
    elevation: 8,
  },
  popupHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 8,
  },
  popupTitle: {
    fontSize: 16,
    fontFamily: 'Urbanist-Bold',
    color: '#212121',
  },
  closeBtn: {
    padding: 4,
  },
  pickerWrapper: {
    paddingHorizontal: 8,
    paddingBottom: 16,
  },
  calendarText: {
    fontFamily: 'Urbanist-Medium',
    color: '#212121',
    fontSize: 12,
  },
  calendarHeader: {
    fontFamily: 'Urbanist-Bold',
    color: '#212121',
    fontSize: 14,
  },
  weekdayText: {
    fontFamily: 'Urbanist-Bold',
    color: '#9E9E9E',
    fontSize: 10,
  },
  headerButton: {
    backgroundColor: '#F5F5F5',
    borderRadius: 6,
    padding: 4,
  }
});
