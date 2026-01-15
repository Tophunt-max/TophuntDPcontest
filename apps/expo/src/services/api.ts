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
  
  // Explicitly route statusHandler/storyHandler calls to the separate storyHandler function
  if (action === 'statusHandler' || action === 'storyHandler') {
    functionName = 'storyHandler';
  } else if (authActions.includes(action)) {
    functionName = 'authHandler';
  } else if (notificationActions.includes(action)) {
    functionName = 'notificationHandler';
  }

  const apiFunction = httpsCallable(functions, functionName);
  
  try {
    let payload = { action, ...data };

    // FIX: For storyHandler, ensure we don't overwrite the internal action if it's already there
    if (functionName === 'storyHandler') {
        // If action is storyHandler, we use the action provided inside data
        // If data doesn't have an action, we use 'action' (which is probably 'storyHandler', which is wrong for the sub-logic)
        // But storyService calls callApi('storyHandler', { action: 'create', ... })
        payload = { ...data }; 
    }

    const result = await apiFunction(payload);
    return result.data;
  } catch (error: any) {
    console.error(`[API Error] Function: ${functionName}, Action: ${action}`, error);
    throw error;
  }
};
