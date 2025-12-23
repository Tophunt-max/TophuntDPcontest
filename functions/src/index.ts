import { setGlobalOptions } from "firebase-functions/v2";

// Set the region and lower resource limits to avoid quota errors
setGlobalOptions({ 
    region: "asia-south1",
    maxInstances: 5,
    memory: "256MiB",
    timeoutSeconds: 60
});

export * from "./signup/checkEmailExists";
export * from "./signup/checkPhoneExists";
export * from "./signup/checkUniqueUsername";
export * from "./signup/createUserRecord";
export * from "./signup/createUser"; // Export the new function
export * from "./admin/notifications";
export * from "./stories/index";
export * from "./posts/index";
export * from "./storage/presignedUrl";

import * as adminFunctions from "./admin";
export const admin = { ...adminFunctions };
