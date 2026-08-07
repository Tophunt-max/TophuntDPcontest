// Update Privacy Policy + Terms of Service in D1 settings/appConfig (via Worker).
// Usage: node scripts/update-legal-content.mjs
import { adminApi } from "./lib/worker.mjs";

const privacyPolicy = `**Last Updated:** October 2023

**1. Introduction**
Welcome to TopHunt DP Contest. We value your privacy and are committed to protecting your personal data. This Privacy Policy explains how we collect, use, and safeguard your information when you use our mobile application.

**2. Information We Collect**
*   **Account Information:** When you register, we collect your name, email address, phone number, and profile picture.
*   **User Content:** We collect the photos, videos, and stories you upload to participate in contests or share with the community.
*   **Social Interactions:** We collect data about your followers, the users you follow, and the messages you send through our chat system.
*   **Transaction Data:** We track your "DP Coin" balance and history of rewards earned or used within the app.
*   **Technical Data:** We automatically collect device information (model, OS version) and usage patterns to improve app performance.

**3. How We Use Your Information**
*   To operate and manage DP contests and leaderboards.
*   To facilitate social features like following other users and messaging.
*   To manage your wallet and reward you with DP Coins for your engagement.
*   To send you important notifications regarding your account or contest status.
*   To provide customer support and resolve technical issues.

**4. Data Sharing and Disclosure**
*   **Public Profile:** Your username, profile picture, and contest entries are visible to other users.
*   **Service Providers:** We share data with trusted partners like Google Firebase (for authentication), Cloudflare (for database and secure media storage), and SMS gateways for phone verification.
*   **Legal Requirements:** We may disclose information if required by law or to protect the safety of our community.

**5. Data Security**
We implement industry-standard security measures, including encryption and secure server protocols, to protect your data from unauthorized access.

**6. Your Rights**
You have the right to:
*   Access and update your personal information through your profile.
*   Request the deletion of your account and all associated data.
*   Opt-out of certain marketing or promotional notifications.

**7. Age Restriction**
TopHunt is intended for users aged 15 and older. We do not knowingly collect data from children under this age.`;

const termsOfService = `**Last Updated:** October 2023

**1. Acceptance of Terms**
By creating an account or using the TopHunt DP Contest app, you agree to be bound by these Terms of Service. If you do not agree, please do not use our services.

**2. Eligibility**
You must be at least 15 years old to use TopHunt. By using the app, you represent that you meet this age requirement.

**3. User Accounts**
*   You are responsible for maintaining the confidentiality of your login credentials.
*   You agree to provide accurate and complete information during registration.
*   Any activity occurring under your account is your sole responsibility.

**4. Contest Rules & Content**
*   **Originality:** You must only upload photos or videos that you own the rights to.
*   **Prohibited Content:** You may not upload content that is pornographic, violent, hateful, or infringes on any third-party intellectual property.
*   **Fair Play:** Any attempt to manipulate contest results using bots, fake accounts, or "vote-for-vote" schemes will result in immediate disqualification and account suspension.

**5. DP Coins & Rewards**
*   "DP Coins" are virtual rewards with no real-world monetary value outside the platform unless explicitly stated by TopHunt.
*   TopHunt reserves the right to modify the reward system, expire coins, or revoke coins earned through fraudulent activity.

**6. Intellectual Property Rights**
*   **Your Content:** You retain ownership of the content you upload. However, by posting on TopHunt, you grant us a worldwide, non-exclusive, royalty-free license to use, display, and promote your content within the app.
*   **Our Content:** The TopHunt logo, UI design, and software are the exclusive property of TopHunt.

**7. Prohibited Conduct**
You agree not to:
*   Harass, bully, or intimidate other users.
*   Reverse engineer or attempt to extract the source code of the app.
*   Use the app for any illegal purposes.

**8. Termination**
We reserve the right to suspend or terminate your account at our sole discretion, without prior notice, for violations of these Terms or behavior that harms the TopHunt community.

**9. Limitation of Liability**
TopHunt is provided "as is." We are not liable for any damages resulting from your use of the app, contest outcomes, or the conduct of other users.`;

try {
  await adminApi("/app-settings", { method: "POST", body: { legalContent: { privacyPolicy, termsOfService } } });
  console.log("Successfully updated Privacy Policy and Terms of Service in D1!");
  process.exit(0);
} catch (e) {
  console.error("Error updating legal content:", e.message);
  process.exit(1);
}
