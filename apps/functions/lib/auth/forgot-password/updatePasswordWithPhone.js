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
exports.updatePasswordWithPhone = void 0;
const functions = __importStar(require("firebase-functions"));
const admin = __importStar(require("firebase-admin"));
exports.updatePasswordWithPhone = functions.https.onCall(async (data, context) => {
    var _a;
    const { phoneNumber, newPassword } = data;
    if (!phoneNumber || !newPassword) {
        throw new functions.https.HttpsError('invalid-argument', 'Phone number and new password are required.');
    }
    const otpRef = admin.firestore().collection('otps').doc(phoneNumber);
    const otpDoc = await otpRef.get();
    if (!otpDoc.exists || !((_a = otpDoc.data()) === null || _a === void 0 ? void 0 : _a.verified)) {
        throw new functions.https.HttpsError('permission-denied', 'You must verify OTP before updating password.');
    }
    try {
        const userRecord = await admin.auth().getUserByPhoneNumber(phoneNumber);
        await admin.auth().updateUser(userRecord.uid, {
            password: newPassword
        });
        await otpRef.delete();
        return { success: true, message: 'Password updated successfully.' };
    }
    catch (error) {
        console.error("Error updating password:", error);
        throw new functions.https.HttpsError('internal', 'Could not update password.', error);
    }
});
//# sourceMappingURL=updatePasswordWithPhone.js.map