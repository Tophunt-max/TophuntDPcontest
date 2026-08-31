/**
 * Bundled legal documents.
 *
 * ## Why these live in code
 *
 * Legal copy used to exist only as four strings inside `settings/appConfig`,
 * written by hand in the admin panel. If nobody had typed them, `/read/app-config`
 * returned `""` and the app rendered "Our terms of service has not been published
 * yet." — which is what tophunt.in/legal/terms, /legal/privacy and /legal/refund
 * were actually serving in production.
 *
 * That is not a content problem, it is a structural one: the documents that are
 * legally REQUIRED to exist (both app stores require a privacy policy, Razorpay
 * requires a refund policy for paid digital goods) were stored in the one place
 * that defaults to empty and is not covered by code review, tests, backups or
 * rollback. An empty policy is also a documented app-store rejection reason.
 *
 * So the canonical text ships with the Worker. It cannot be empty, it is
 * versioned in git, and a bad edit is revertable. Admin content still wins when
 * present (see `resolveLegalContent`), so operations keeps the ability to publish
 * a change without a deploy — it just can no longer publish *nothing*.
 *
 * ## Accuracy over boilerplate
 *
 * These are written against what this codebase actually does, not from a
 * template. Specifically:
 *
 *   - 18+ only, because `MINIMUM_AGE` in signup/fill-profile enforces it and
 *     withdrawals pay real money.
 *   - Razorpay is the only gateway (`lib/payments.ts`), so it is named.
 *   - Coins are bought in packages priced server-side (`api.ts createOrder`),
 *     spent on entry fees, and withdrawn at an admin-set `conversionRate` with
 *     min/max/daily limits — the refund policy has to describe that shape.
 *   - The retention list in the privacy policy is copied from the one in
 *     `lib/accountDeletion.ts`, which is the code that actually decides what
 *     survives a deletion. If that list changes, this one must change with it.
 *
 * `{{SUPPORT_EMAIL}}` is interpolated at serve time from `appConfig.supportEmail`
 * so the contact address is never stale or duplicated.
 *
 * NOTE FOR OPERATIONS: this is an accurate description of the product's current
 * behaviour, and is the right baseline to have live rather than nothing. Have
 * counsel review it before an app-store submission, and fill in the registered
 * entity name and address where marked in the Contact sections.
 */

/** The four documents the app renders. Mirrors `LegalDocKey` in the Expo app. */
export interface LegalContent {
  privacyPolicy: string;
  termsOfService: string;
  refundPolicy: string;
  communityGuidelines: string;
}

export type LegalDocKey = keyof LegalContent;

export const LEGAL_DOC_KEYS: readonly LegalDocKey[] = [
  "privacyPolicy",
  "termsOfService",
  "refundPolicy",
  "communityGuidelines",
] as const;

/**
 * Bump this whenever the substance of a document below changes.
 *
 * It is rendered as "Last updated" on each screen, so it must be edited in the
 * same commit as the text — a policy showing a date older than its own content is
 * worse than showing no date, because it invites the reader to assume nothing has
 * changed.
 */
export const LEGAL_LAST_UPDATED = "31 August 2026";

const FALLBACK_SUPPORT_EMAIL = "support@tophunt.in";

const TERMS_OF_SERVICE = `**Last updated: ${LEGAL_LAST_UPDATED}**

These terms are the agreement between you and TopHunt ("TopHunt", "we", "us"). They cover the TopHunt app and tophunt.in. By creating an account or entering a contest you accept them. If you do not accept them, do not use TopHunt.

## 1. Who may use TopHunt

You must be at least 18 years old. TopHunt involves paid entry into contests and the withdrawal of real money, so there is no under-18 tier and no parental-consent route — we will close an account if we learn its holder is a minor and refund any unspent balance to the source of payment.

You must be legally permitted to take part in paid skill contests where you live. Some Indian states restrict or prohibit paid contests regardless of whether they turn on skill. You are responsible for knowing your local position, and by entering a paid contest you confirm you may lawfully do so.

One person, one account. Additional accounts, accounts registered on someone else's identity documents, and accounts operated by software are all prohibited.

## 2. Your account

You give us accurate registration details and keep them accurate. Your date of birth, phone number and email are used to verify eligibility and to pay you, so wrong details will eventually block a withdrawal.

You are responsible for what happens under your login, including anything done by someone you let use your device. Tell us at {{SUPPORT_EMAIL}} immediately if you think someone else has access to your account.

We may suspend or close an account that breaks these terms, the Community Guidelines, or the law. Where the reason is not fraud or a legal obligation, we will tell you why and, where a balance is not itself the subject of the investigation, allow you to withdraw it subject to the usual limits.

## 3. Contests

**How contests work.** A contest is a head-to-head or multi-entrant comparison of user-submitted photos or videos, decided by votes from other users, within a fixed window. Some contests are free; some require an entry fee in coins. Every contest states its fee, prize and closing time before you join.

**Outcomes are decided by votes and by skill.** Prizes reflect how your entry performs against other entries — its subject, composition, effort and appeal. TopHunt is not a game of chance and there is no wagering on an outside event.

**Entering is final.** Once you have joined a contest your entry fee is committed and cannot be returned, because your opponent's contest now depends on your entry existing. See the Refund Policy for the narrow exceptions.

**Fair play.** The following void an entry and forfeit its fee:

- Voting for your own entry through any other account.
- Buying, selling, exchanging or organising votes, including vote-for-vote arrangements.
- Using bots, scripts, emulators, automation or multiple devices to influence a result.
- Coordinating with another entrant to fix an outcome.
- Entering media you did not create or do not have the rights to.
- Interfering with another user's ability to take part.

We detect these through device signals, voting patterns and account relationships. Where we void an entry we will say so in writing and, where the result of a contest has already been paid out, we may reverse the credit.

**Results.** A result is final once the contest closes and the prize is credited. If you believe a result is wrong, write to {{SUPPORT_EMAIL}} within 7 days of the close and we will re-examine the entries and the vote log.

## 4. Coins, payments and prizes

**Coins are a prepaid in-app credit.** They are not currency, not a stored-value instrument, not a security, and they earn no interest. They exist only inside TopHunt.

**Buying coins.** Coin packages are priced in Indian rupees and processed by Razorpay. We do not see or store your card, UPI or bank credentials. Price and coin quantity are set on our servers at the moment you order, so what you are charged is always the amount shown on the package you tapped.

**Earning coins.** Coins can also arrive without payment — signup and referral bonuses, daily rewards, contest prizes and, where enabled, rewarded ads. We may adjust the rate of any reward at any time. Rewards are promotional, and we may reverse them if they were obtained by abusing the mechanism.

**Spending coins.** Coins pay contest entry fees and anything else the app offers them for. Spending is deducted from your balance immediately.

**Withdrawing.** Coins won or held can be converted to money and paid to your verified account, subject to the conversion rate, minimum, maximum and per-day limits shown on the withdrawal screen. We may require identity verification before a first payout, and we may hold a payout while we investigate a specific fair-play concern. Withdrawals are processed in batches and are not instant.

**We may freeze payouts.** During a suspected-fraud incident or a payment-provider outage we may suspend all withdrawals. We will restore them as soon as it is safe, and a freeze does not affect the balance itself.

**Taxes are yours.** Prize money may be taxable where you live, and Indian tax law may require us to withhold tax at source on winnings. Any withholding is deducted from the payout and reported against your details.

## 5. Your content

You keep ownership of the photos and videos you upload. You give us a worldwide, royalty-free licence to host, resize, transcode, cache, display and distribute them for the purpose of operating and promoting TopHunt, including in a contest feed, a leaderboard and, where you are a winner, in promotional material about that contest. This licence lasts as long as the content is on TopHunt, and survives afterwards only for copies already distributed and for the records described in the Privacy Policy.

You confirm that you own or are licensed to use everything you upload, that everyone recognisable in it has agreed to appear, and that it does not break the Community Guidelines.

We may remove content that breaks the Guidelines or the law, and we may do so without notice where it is illegal or harmful. Repeatedly uploading infringing content will close your account.

If you believe content on TopHunt infringes your copyright, write to {{SUPPORT_EMAIL}} identifying the work, the location of the copy, and your authority to act. We will remove or disable it while we investigate.

## 6. What you may not do

- Break the law, or help anyone else to.
- Impersonate anyone, including us.
- Upload malware, or probe, scrape, overload or reverse-engineer any part of the service.
- Use an automated client, a modified build of the app, or an emulator to take part in contests.
- Extract our data in bulk, or use TopHunt content to train a model without our written permission.
- Resell or sublicense access to TopHunt.

## 7. Availability and change

We change TopHunt continuously. Features arrive, change and are withdrawn. We may require a minimum app version, and we may take the service down for maintenance. We aim to give notice of anything that affects a balance or an open contest, and we will always let an open contest finish or refund its fee if we cannot.

We do not promise uninterrupted service. TopHunt depends on networks, app stores, payment providers and cloud infrastructure we do not control.

## 8. Ending the agreement

You can stop using TopHunt at any time and delete your account from Settings. Deletion is permanent, it is blocked while you have a contest in progress, and any remaining coin balance is forfeited — so withdraw what you can first. What survives deletion is set out in the Privacy Policy.

We may end your access if you break these terms. Sections that should outlive the agreement — content licences already granted, liability, financial records, and dispute resolution — do.

## 9. Liability

TopHunt is provided as it is. To the extent the law allows, we exclude implied warranties.

We are not liable for indirect or consequential loss, for lost profits, or for loss of goodwill or opportunity. Where we are liable, our total liability to you is capped at the greater of the amount you paid us in the 12 months before the claim, or ₹5,000.

Nothing here excludes liability that cannot lawfully be excluded, including for fraud, or for death or personal injury caused by negligence.

## 10. Disputes

Please write to {{SUPPORT_EMAIL}} first — nearly everything is resolved there, and it is faster than any alternative.

These terms are governed by the law of India. The courts of India have jurisdiction, and you and we submit to them.

## 11. Changes to these terms

We may update these terms. When a change materially affects your rights, your balance or the cost of taking part, we will notify you in the app before it takes effect. Continuing to use TopHunt after that point means you accept the updated terms. Every version carries the date it was published at the top.

## 12. Contact

Write to {{SUPPORT_EMAIL}}.

Registered entity name and address: available on request from the address above, and stated in full on our published grievance page.`;

const PRIVACY_POLICY = `**Last updated: ${LEGAL_LAST_UPDATED}**

This policy explains what TopHunt collects about you, why, who else sees it, and what you can do about it. It describes the app and tophunt.in.

The short version: we collect what is needed to run an account, judge contests fairly and pay you. We do not sell your personal information.

## 1. What we collect

**What you give us when you sign up.** Name, username, email address, phone number, date of birth, and a profile photo. We ask for date of birth because paid contests are 18+ and we have to be able to show we checked. We ask for phone and email because they are how we verify it is you and how we reach you about a payout.

**Optional profile details.** Bio, occupation, gender, and links to your Facebook, X or Instagram profiles. These are optional and, apart from gender and occupation, publicly visible.

**What you create.** The photos and videos you enter into contests, your posts, stories, comments, likes, votes, and who you follow.

**Contest and wallet activity.** Contests you joined, entry fees, results, coin credits and debits, coin purchases, and withdrawal requests including the payout details you give us for them.

**Payment data — via Razorpay, not us.** Card, UPI and bank credentials are collected and held by Razorpay. We receive only an order reference, an amount, a status, and the last few digits or handle needed to identify a transaction in support. We never see your full card number or your banking password.

**Technical and device data.** IP address, device model, operating system, app version, crash reports, and a push-notification token if you allow notifications. We also record coarse device identifiers used to detect the same person running several accounts — the fair-play rules in the Terms depend on this, and a contest cannot be fair without it.

**Approximate location.** Where you allow it, coordinates used for region-specific contests and for eligibility. We do not track your movements.

**Support correspondence.** Problem reports, tickets and the diagnostic details you attach.

We do not collect your contacts, your calendar, or your messages in other apps.

## 2. Why we use it

- **To run your account** — sign-in, profile, followers, notifications.
- **To run contests** — matching entries, counting votes, deciding results, showing leaderboards.
- **To keep contests fair** — detecting duplicate accounts, vote manipulation, bots and collusion. This is the purpose most likely to result in an account being restricted, so it is worth naming plainly.
- **To take payment and pay you** — coin purchases, prize credits, withdrawals, and the tax records that follow.
- **To keep the service safe** — moderating content, acting on reports, blocking abuse.
- **To support you** — answering what you write to us.
- **To improve TopHunt** — aggregate usage and crash data. We do not need to know who you are to fix a crash, and we do not look.
- **To meet legal obligations** — accounting, tax, and lawful requests from authorities.

We rely on performing our contract with you for most of this, on our legitimate interest in a fair and safe platform for anti-fraud and moderation, on your consent for location and push notifications, and on legal obligation for financial records.

## 3. What other people can see

**Public:** your username, name, profile photo, bio, social links, contest entries, posts, stories, wins, follower and following counts, and your position on public leaderboards.

**Not public:** your email address, phone number, date of birth, exact coin balance, transactions, withdrawal details, location, device data, and anything you send to support.

**A private account** limits your entries and stories to people you approve, and takes you out of public discovery surfaces. It does not retroactively hide a contest you already entered — the other entrant's result depends on it being visible.

**Who has blocked you is never disclosed**, to you or to anyone. Our API does not return it in either direction beyond your own outgoing list.

## 4. Who we share it with

We share personal data only with providers who process it for us under contract, and only what each needs:

- **Google Firebase** — authentication and push notifications.
- **Cloudflare** — application hosting, database, media storage and delivery.
- **Bunny Stream** — video transcoding and delivery.
- **Razorpay** — payment processing and payouts.
- **An SMS and an email provider** — one-time codes and account email.

We also disclose data where the law requires it, to respond to a valid legal request, to enforce our Terms, or to protect someone's safety. If TopHunt is ever sold or merged, account data moves with it and we will tell you before it does.

**We do not sell your personal information, and we do not share it with advertisers for their own use.**

Some of these providers operate outside India. Where data crosses a border it stays under contractual protection at least as strong as this policy.

## 5. How long we keep it

While your account is open, we keep your data for as long as it is useful for the purposes above.

When you delete your account, we anonymise it and delete your own content — profile, photo, bio, contact details, posts, stories, comments, likes, saved items, followers, notifications, and your login. Media files are removed from storage.

**What survives deletion, and why:**

- **Coin transactions, payments, payment orders, deposits and withdrawals** — accounting and tax records we are legally required to retain. They stay keyed to an identifier that is no longer linked to your name, email or phone.
- **Votes and contests you took part in** — other entrants' results are computed from them. Removing your votes would silently change someone else's outcome.
- **Administrative audit records** — the log of actions our own staff took.

None of these remain linked to your identity. Retained financial records are kept for the period Indian tax and accounting law requires, and then deleted.

Deletion is blocked while you are in an unfinished contest. That is why the Delete Account screen sometimes tells you to wait: your entry is part of a live result.

## 6. Your rights

You can:

- **See and correct** your data — most of it directly in Edit Profile.
- **Delete your account** — Settings, then Delete Account. It is permanent.
- **Get a copy** of your data — write to {{SUPPORT_EMAIL}}.
- **Withdraw consent** for location or notifications — in your device settings, at any time.
- **Object to or restrict** a use we base on legitimate interest — write to us and we will consider it and reply.
- **Complain** — to us first at {{SUPPORT_EMAIL}}, and to your data protection authority if we do not resolve it.

We answer rights requests within 30 days. We will ask you to confirm who you are first, because acting on an impersonated request would be the worse failure.

## 7. Security

Data is encrypted in transit. Passwords are handled by Firebase Authentication and are never stored by us in a readable form. Payment credentials never reach our servers. Access to production data is limited to staff who need it and is logged. Push tokens are detached from an account at logout, so a resold or shared phone does not keep receiving the previous account's notifications.

No system is perfectly secure. If a breach affects you, we will tell you and the relevant authority as the law requires.

## 8. Children

TopHunt is 18+. We do not knowingly collect data from children. If we learn that an account belongs to a minor we close it and delete the data. If you believe a child is using TopHunt, write to {{SUPPORT_EMAIL}}.

## 9. Cookies and similar technologies

On tophunt.in we use local storage and similar technologies to keep you signed in, remember your theme preference, and measure aggregate usage. We do not use them for advertising. Clearing your browser storage signs you out.

## 10. Changes

We will update this policy as TopHunt changes. Material changes are announced in the app before they take effect, and the date at the top always reflects the current version.

## 11. Contact

Write to {{SUPPORT_EMAIL}} for any privacy question, data request or complaint.

Registered entity name and address: available on request from the address above, and stated in full on our published grievance page.`;

const REFUND_POLICY = `**Last updated: ${LEGAL_LAST_UPDATED}**

This policy covers coin purchases, contest entry fees and withdrawals. It applies to every payment made through the TopHunt app or tophunt.in.

## 1. What you are buying

TopHunt sells **coins**: a prepaid credit, delivered to your account immediately, spendable on contest entry fees and other in-app items. Coins are a digital good, consumed on use, and delivery is instant and irreversible.

Because of that, a completed coin purchase is **not refundable once the coins have been spent**. Unspent coins can be refunded in the cases below.

## 2. Failed and duplicated payments — always refunded

If money left your account and coins did not arrive, that is our problem to fix, not yours to claim.

- **Payment taken, coins not credited.** Our server reconciles every Razorpay order automatically, so this usually corrects itself within a few minutes. If it does not, write to us and we will credit the coins or return the money, whichever you prefer.
- **Charged twice for one purchase.** The duplicate is refunded in full.
- **Payment failed at the gateway.** Razorpay releases the authorisation and your bank returns the amount, normally within 5–7 working days. No action is needed from us or from you.

Refunds in this section carry no deduction. Contact us at {{SUPPORT_EMAIL}} with the date, the amount and the payment reference from your bank or UPI app.

## 3. Unspent coins — refundable within 7 days

If you bought coins and have not spent them, you can ask for the purchase to be reversed within **7 days** of payment.

Conditions:

- The coins from that purchase are still in your balance, in full.
- You have not entered a paid contest using them.
- The purchase was not made with a promotional or bonus credit.

We reverse the coins and return the money to the original payment method. It reaches you in 5–10 working days depending on your bank.

Partly spent purchases are not reversed. Once coins have paid an entry fee, that fee is in a contest.

## 4. Contest entry fees — not refundable

An entry fee is committed the moment you join a contest, and it is not refundable — including if you lose, if you change your mind, if you run out of time to upload, or if you are dissatisfied with the result.

The reason is that your entry becomes part of someone else's contest. Refunding you would either delete an opponent's live match or pay out a prize decided against an entry that no longer exists.

**We do refund an entry fee when the failure is ours:**

- A contest is cancelled by us before it closes.
- A technical fault on our side stops the contest from being judged.
- A contest closes with no valid opponent and no result.
- Your entry is removed by us in error.

In each case the fee returns to your coin balance automatically, usually within 24 hours. Coins refunded this way go back as coins, not money, because coins is what was spent.

## 5. Voided entries — not refunded

If we void an entry for breaking the fair-play rules in the Terms of Service — vote buying, self-voting through another account, bots, multiple accounts, collusion, or entering media you do not own — the entry fee is forfeited and not refunded, and a prize already credited may be reversed.

We tell you in writing when we void an entry, and you can dispute it at {{SUPPORT_EMAIL}}.

## 6. Withdrawals are not refunds

Converting coins to money is a **withdrawal**, not a refund, and it follows the rules on the withdrawal screen: a minimum and maximum per request, a daily cap, and the current conversion rate. Withdrawals are processed in batches and are not instant.

A withdrawal cannot be cancelled once it is submitted for payout. If it fails at the bank, the coins return to your balance and you can request it again with corrected details.

We may hold a withdrawal while we verify your identity or investigate a fair-play concern, and we may suspend all payouts during a fraud incident or a payment-provider outage. A hold is not a forfeiture: the balance stays yours.

## 7. Purchases made through an app store

If you bought coins through Apple's App Store or Google Play rather than through Razorpay, that platform's own refund process applies and we cannot process the refund ourselves. Ask Apple or Google. Tell us afterwards, because a store refund removes the coins from your balance and we would rather explain that than have you discover it.

## 8. Account closure

Deleting your account forfeits any remaining coin balance. Withdraw what you can before you delete. We cannot restore a deleted account or its balance.

If **we** close your account for a reason other than fraud, we will let you withdraw an eligible balance subject to the normal limits.

## 9. Chargebacks

Please write to us before raising a chargeback with your bank — we can usually resolve it in a day, and a chargeback takes weeks. Raising one suspends your account until it is settled, because the balance is disputed while it is open.

## 10. How to request a refund

Email {{SUPPORT_EMAIL}} with:

- the registered email or phone on your account,
- the date and amount of the payment,
- the payment reference from Razorpay, your bank or your UPI app,
- what happened.

We acknowledge within 2 working days and decide within 7. Approved refunds are issued to the original payment method only — we cannot pay a refund to a different account, since that is how refund fraud works.

## 11. Contact

Write to {{SUPPORT_EMAIL}}. If you are unhappy with a refund decision, say so in your reply and it will be reviewed by someone who did not make it.`;

const COMMUNITY_GUIDELINES = `**Last updated: ${LEGAL_LAST_UPDATED}**

TopHunt is a contest platform: people put their photos and videos up against each other and other people vote. That only works while entries are honest and the voting is real. These guidelines are how we keep it that way.

They apply to everything you post — entries, posts, stories, comments, your profile, and your username.

## 1. Post your own work

Enter photos and videos **you** created. Not something you found, not a screenshot, not someone else's entry, not AI-generated media presented as a photograph of you.

Everyone recognisable in what you post must have agreed to appear in it. Do not post other people's children.

If you hold the rights to something you did not personally shoot, you may still enter it — but be ready to show that you do.

## 2. Win by being good, not by gaming

This is the rule with the most consequences attached, so it is worth being exact about.

**Not allowed:**

- Voting for yourself from another account.
- Buying, selling or trading votes. Vote-for-vote groups count.
- Bots, scripts, automation, emulators, or several devices used to influence a result.
- More than one account per person.
- Agreeing an outcome with another entrant.

**What happens:** the entry is voided and its fee is forfeited, a prize already paid may be reversed, and the account may be closed. We detect this from device signals, voting patterns and the relationships between accounts, and we act on the pattern rather than on a single vote.

## 3. Keep it safe to look at

Do not post:

- Sexual content, nudity, or anything sexualising a minor in any way at all. This is the one line where we report to the authorities as well as removing the content.
- Graphic violence, gore, or cruelty to animals.
- Self-harm or suicide content, or anything encouraging it. If you are struggling, please talk to someone — a crisis line in your country will take your call.
- Content promoting weapons, illegal drugs or criminal activity.
- Shocking content posted to disturb people.

## 4. Treat people decently

No harassment, no threats, no targeted pile-ons, and no hate. That means no attacking someone for their religion, caste, ethnicity, nationality, gender, sexual orientation, disability or appearance.

No sharing someone's private information — address, phone number, workplace, documents — without their agreement.

Disagreeing with people is fine. Voting against someone is the entire point of the app. Making the platform unpleasant for them is not.

## 5. Be who you say you are

Do not impersonate another person, a brand, a public figure, or TopHunt staff. Do not use someone else's photo as your profile picture. Do not run an account pretending to be an official one.

Parody and fan accounts are fine when they are obviously that and say so.

## 6. No spam, no scams

- No repetitive or bulk posting, and no unrelated content pushed into contest feeds.
- No fake giveaways, investment offers, "double your coins" schemes or phishing links.
- No selling accounts, coins, votes or followers.
- No promoting other platforms in a way that just uses TopHunt as a billboard.

Nobody from TopHunt will ever ask you for your password or an OTP. Anyone who does is trying to steal your account — report them.

## 7. Nothing illegal

Do not use TopHunt to break the law or to help anyone else break it. Do not post content that infringes someone's copyright or trademark.

## 8. Reporting, and what we do about it

Report anything that breaks these guidelines from the report option on the content, or write to {{SUPPORT_EMAIL}}. Tell us what you saw and where — specifics let us act on the same day.

Reports are confidential. The person you report is not told who reported them.

You can also **block** someone, which hides both of you from each other, or **mute** them, which quietly removes them from your feed without their knowing. Both are reversible from Settings, then Blocked & Muted.

**How we respond**, roughly in order of severity: we remove the content; we void an entry and forfeit its fee; we limit an account's ability to post or vote; we suspend it; we close it permanently. Child sexual content, credible threats of violence and coordinated fraud go straight to the last step.

**Repeat matters.** A first mistake usually gets a removal and an explanation. A pattern gets an account closed.

**You can appeal.** Reply to the notice you received, or write to {{SUPPORT_EMAIL}}. An appeal is reviewed by someone other than the person who made the original decision. If we got it wrong we will say so and restore what we removed.

## 9. These guidelines change

As the platform grows we will add to this list — usually because something happened that it did not cover. The date at the top tells you which version you are reading.

Thanks for keeping TopHunt worth competing on.`;

/** The bundled documents, before support-email interpolation. */
const BUNDLED: LegalContent = {
  termsOfService: TERMS_OF_SERVICE,
  privacyPolicy: PRIVACY_POLICY,
  refundPolicy: REFUND_POLICY,
  communityGuidelines: COMMUNITY_GUIDELINES,
};

/**
 * Substitute the configured support address into a document.
 *
 * Kept as a token rather than hardcoded so the address lives in exactly one place
 * (`appConfig.supportEmail`, the same value the Settings screen uses). Admin-authored
 * documents get the same treatment, so an operator can use the token too.
 */
function interpolate(text: string, supportEmail: string): string {
  return text.replace(/\{\{SUPPORT_EMAIL\}\}/g, supportEmail);
}

/**
 * The legal documents to serve, given the stored app config.
 *
 * Admin-authored content wins when it is present and not just whitespace;
 * otherwise the bundled document is served. This is deliberately per-document:
 * an operator who has written a custom Terms of Service should not thereby lose
 * the bundled Privacy Policy.
 *
 * The result is that no legal screen can ever render "not published yet" —
 * which was the production bug this file exists to fix.
 */
export function resolveLegalContent(cfg: any): LegalContent {
  const stored = (cfg?.legalContent ?? {}) as Partial<Record<LegalDocKey, unknown>>;
  const supportEmail =
    (typeof cfg?.supportEmail === "string" && cfg.supportEmail.trim()) || FALLBACK_SUPPORT_EMAIL;

  const out = {} as LegalContent;
  for (const key of LEGAL_DOC_KEYS) {
    const value = stored[key];
    const custom = typeof value === "string" ? value.trim() : "";
    out[key] = interpolate(custom || BUNDLED[key], supportEmail);
  }
  return out;
}
