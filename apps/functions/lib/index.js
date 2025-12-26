"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
const v2_1 = require("firebase-functions/v2");
(0, v2_1.setGlobalOptions)({
    region: "asia-south1",
    maxInstances: 5,
    memory: "256MiB",
    timeoutSeconds: 60
});
__exportStar(require("./signup/checkEmailExists"), exports);
__exportStar(require("./signup/checkPhoneExists"), exports);
__exportStar(require("./signup/checkUniqueUsername"), exports);
__exportStar(require("./signup/createUserRecord"), exports);
__exportStar(require("./signup/createUser"), exports);
__exportStar(require("./notifications/index"), exports);
__exportStar(require("./stories/index"), exports);
__exportStar(require("./posts/index"), exports);
__exportStar(require("./storage/presignedUrl"), exports);
__exportStar(require("./user/emailUpdate"), exports);
__exportStar(require("./user/phoneUpdate"), exports);
__exportStar(require("./user/toggleFollow"), exports);
__exportStar(require("./contests/joinContest"), exports);
__exportStar(require("./contests/vote"), exports);
__exportStar(require("./contests/finalize"), exports);
__exportStar(require("./wallet/topup"), exports);
//# sourceMappingURL=index.js.map