import { httpsCallable } from 'firebase/functions';
import { functions } from './firebase/initFirebase';

/**
 * Ye hamara Central API Caller hai.
 */
export const callApi = async (action: string, data: any = {}) => {
  // List of actions that belong to the authHandler
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

  let functionName = 'api';
  
  if (authActions.includes(action)) {
    functionName = 'authHandler';
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
