import { setGlobalOptions } from "firebase-functions/v2";

setGlobalOptions({ 
    region: "asia-south1",
    maxInstances: 5, // Limit cost by capping instances
    minInstances: 0, // No cost when idle
    memory: "256MiB", // Lowest memory tier
    timeoutSeconds: 60,
    concurrency: 500 // HUGE SAVINGS: One instance handles 500 simultaneous requests
});

export * from "./signup/checkEmailExists";
export * from "./signup/checkPhoneExists";
export * from "./signup/checkUniqueUsername";
export * from "./signup/createUserRecord";
export * from "./signup/createUser"; 
export * from "./notifications/index";
export * from "./stories/index";
export * from "./posts/index";
export * from "./storage/presignedUrl";
export * from "./user/emailUpdate";
export * from "./user/phoneUpdate";
export * from "./user/toggleFollow";
export * from "./contests/joinContest";
export * from "./contests/vote";
export * from "./contests/finalize";
export * from "./wallet/topup";

// Optional: If you want to use the Merged approach, you would export ONE function here.
// export * from "./universalRouter"; 
