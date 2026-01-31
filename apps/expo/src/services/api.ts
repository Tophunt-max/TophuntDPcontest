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
  
  if (action === 'statusHandler' || action === 'storyHandler') {
    functionName = 'storyHandler';
  } else if (authActions.includes(action)) {
    functionName = 'authHandler';
  } else if (notificationActions.includes(action)) {
    functionName = 'notificationHandler';
  }

  const apiFunction = httpsCallable(functions, functionName);
  
  try {
    // FIX: Action field handling to avoid duplicates and ensure consistency
    // If 'action' is passed as the first argument, we use it.
    // If 'data' already contains an 'action', it might be a nested call or legacy.
    // We prioritize the 'action' argument.
    const { action: dataAction, ...restData } = data;
    const payload = { action: action, ...restData };

    const result = await apiFunction(payload);
    return result.data;
  } catch (error: any) {
    console.error(`[API Error] Function: ${functionName}, Action: ${action}`, error);
    throw error;
  }
};
