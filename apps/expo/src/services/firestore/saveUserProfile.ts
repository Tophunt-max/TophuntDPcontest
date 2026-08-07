import { auth } from "../firebase/initFirebase";
import { callApi } from "../api";

/**
 * Persist the current user's profile fields. Was a Firestore setDoc(merge);
 * now the Worker /api `updateProfile` action (merges into D1, unknown fields
 * go into the users.extra JSON column).
 */
export const saveUserProfile = async (data: any) => {
  const user = auth.currentUser;
  if (!user) throw new Error("No authenticated user found");
  await callApi("updateProfile", data);
};

export const completeSignup = async () => {
  const user = auth.currentUser;
  if (!user) throw new Error("No authenticated user found");
  await callApi("completeSignup", {});
};
