import { httpsCallable } from 'firebase/functions';
import { functions } from './firebase/initFirebase';

/**
 * Ye hamara Central API Caller hai.
 */
export const callApi = async (action: string, data: any = {}) => {
  // Actions that belong to the authHandler
  const authActions = [
    'check', 
    'create', 
    'createProfile', 
    'getUserByIdentifier', 
    'sendOtpToPhone', 
    'verifyOtp', 
    'updatePasswordWithPhone',
    'sendEmailOtp',
    'verifyEmailOtp',
    'sendPhoneOtp',
    'verifyPhoneOtp'
  ];

  // Actions that belong to the notificationHandler
  const notificationActions = [
    'sendNotification',
    'markAsRead',
    'getNotificationsCount',
    'broadcast'
  ];

  let functionName = 'api';
  
  if (authActions.includes(action)) {
    functionName = 'authHandler';
  } else if (notificationActions.includes(action)) {
    functionName = 'notificationHandler';
  }

  const apiFunction = httpsCallable(functions, functionName);
  
  try {
    const result = await apiFunction({ action, ...data });
    return result.data;
  } catch (error: any) {
    console.error(`[API Error] Function: ${functionName}, Action: ${action}`, error);
    throw error;
  }
};
