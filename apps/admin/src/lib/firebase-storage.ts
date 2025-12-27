import { storage } from "@/lib/firebase/config";
import { ref, uploadBytes, getDownloadURL } from "firebase/storage";

// Using the default bucket from config or explicitly mentioning if needed
export async function uploadToFirebaseStorage(file: File, path: string) {
  try {
    // This uses the bucket defined in your firebaseConfig (tophuntdpcontest.firebasestorage.app)
    const storageRef = ref(storage, path);
    const snapshot = await uploadBytes(storageRef, file);
    const downloadURL = await getDownloadURL(snapshot.ref);
    return downloadURL;
  } catch (error) {
    console.error("Firebase Storage Upload Error:", error);
    throw error;
  }
}
