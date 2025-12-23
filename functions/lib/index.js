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
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.admin = void 0;
const v2_1 = require("firebase-functions/v2");
// Set the region and lower resource limits to avoid quota errors
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
__exportStar(require("./signup/createUser"), exports); // Export the new function
__exportStar(require("./admin/notifications"), exports);
__exportStar(require("./stories/index"), exports);
__exportStar(require("./posts/index"), exports);
__exportStar(require("./storage/presignedUrl"), exports);
const adminFunctions = __importStar(require("./admin"));
exports.admin = Object.assign({}, adminFunctions);
//# sourceMappingURL=index.js.map