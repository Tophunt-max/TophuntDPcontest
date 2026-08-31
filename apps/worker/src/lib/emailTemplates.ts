/**
 * Branded transactional email templates.
 *
 * Every email the app sends used to be a one-line `<h3>` + `<p>` built inline at
 * the call site — no branding, no layout, no consistent footer, and a different
 * shape each time. That is both a deliverability risk (bare HTML with no text
 * part and no structure reads as spammy) and a trust one (a security email that
 * looks nothing like the last one is easy to mistake for a phish).
 *
 * This centralises the look. Each template returns `{ subject, html, text }`:
 *  - `html` is wrapped in one shared, inline-styled, mobile-safe layout. Email
 *    clients strip <style> and <head>, ignore flexbox and external CSS, so this
 *    is deliberately table-based with every style inlined — the ugly-but-correct
 *    way email has always had to be built.
 *  - `text` is a real plain-text alternative, not an afterthought. A message with
 *    only an HTML part is a strong spam signal; the multipart send in email.ts
 *    passes both.
 *
 * The catalogue (see the exported functions):
 *  1. verificationCodeEmail   — confirm a NEW email address (email change)
 *  2. securityCodeEmail       — "confirm it's you" before a sensitive action
 *  3. identifierChangedEmail  — alert to the OLD address/number after a change
 *  4. welcomeEmail            — after a new account finishes signup
 *  5. accountDeletionScheduledEmail — deletion requested, with the cancel date
 *  6. testEmail               — the admin-panel "Test connection" probe
 *  7. coinsAddedEmail         — a top-up / manual deposit landed in the wallet
 *  8. coinsReversedEmail      — a payment was refunded/charged back; coins pulled
 *  9. withdrawalDecisionEmail — payout approved / paid / rejected
 * 10. contestWinEmail         — won a battle, with the prize credited
 * 11. contestRefundEmail      — a battle voided/tied/cancelled; entry fee back
 * 12. passwordChangedEmail    — security alert after the password was changed
 *
 * The financial ones (7–11) are receipts a user expects to keep: a wallet or
 * payout event that exists only as an in-app toast is one they cannot find later
 * when they need proof, and a chargeback that silently makes a balance negative
 * reads as theft. The security one (12) is the account-takeover tripwire — the
 * one email whose absence means a compromise goes unnoticed.
 */

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

/** Brand constants. Kept here so every template is visually identical. */
const BRAND = {
  name: "TopHunt",
  /** App primary (the pink/red used across the app UI). */
  color: "#FF4D67",
  bg: "#F4F4F7",
  card: "#FFFFFF",
  text: "#1F2430",
  muted: "#6B7280",
  border: "#ECECF1",
};

const DEFAULT_SUPPORT_EMAIL = "support@tophunt.in";

/** HTML-escape untrusted values before they go into the markup. */
function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

interface LayoutParts {
  /** Preheader — the grey preview line shown in the inbox before opening. */
  preview: string;
  heading: string;
  /** Body paragraphs (already plain text; escaped and wrapped in <p>). */
  paragraphs: string[];
  /** A big, letter-spaced one-time code, rendered in its own block. */
  code?: string;
  /** A call-to-action button. */
  cta?: { label: string; url: string };
  /** A small tinted note under the body (e.g. a security warning). */
  note?: string;
  supportEmail: string;
}

/**
 * The one shared layout. Table-based and fully inlined on purpose — see the file
 * header for why email cannot use the normal CSS toolkit.
 */
function layout(parts: LayoutParts): string {
  const paras = parts.paragraphs
    .map(
      (p) =>
        `<p style="margin:0 0 16px;font-size:15px;line-height:22px;color:${BRAND.text};">${p}</p>`,
    )
    .join("");

  const codeBlock = parts.code
    ? `<div style="margin:8px 0 20px;padding:16px;background:${BRAND.bg};border:1px solid ${BRAND.border};border-radius:12px;text-align:center;">
         <span style="font-size:30px;font-weight:700;letter-spacing:8px;color:${BRAND.text};font-family:'Courier New',monospace;">${esc(
           parts.code,
         )}</span>
       </div>`
    : "";

  const ctaBlock = parts.cta
    ? `<div style="margin:8px 0 20px;">
         <a href="${esc(parts.cta.url)}" style="display:inline-block;background:${BRAND.color};color:#fff;text-decoration:none;font-size:15px;font-weight:700;padding:12px 28px;border-radius:100px;">${esc(
           parts.cta.label,
         )}</a>
       </div>`
    : "";

  const noteBlock = parts.note
    ? `<div style="margin:8px 0 4px;padding:12px 14px;background:#FFF4F5;border:1px solid #FFD9DE;border-radius:12px;">
         <p style="margin:0;font-size:13px;line-height:19px;color:#8A2532;">${parts.note}</p>
       </div>`
    : "";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <meta name="color-scheme" content="light only" />
    <title>${esc(parts.heading)}</title>
  </head>
  <body style="margin:0;padding:0;background:${BRAND.bg};">
    <!-- preheader: shown as the inbox preview, then hidden -->
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(parts.preview)}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.bg};padding:24px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;background:${BRAND.card};border:1px solid ${BRAND.border};border-radius:16px;overflow:hidden;">
            <tr>
              <td style="padding:22px 28px 8px;">
                <span style="font-size:22px;font-weight:800;color:${BRAND.color};letter-spacing:-0.5px;">${BRAND.name}</span>
              </td>
            </tr>
            <tr>
              <td style="padding:4px 28px 24px;">
                <h1 style="margin:8px 0 14px;font-size:20px;line-height:26px;color:${BRAND.text};font-weight:800;">${esc(
                  parts.heading,
                )}</h1>
                ${paras}
                ${codeBlock}
                ${ctaBlock}
                ${noteBlock}
              </td>
            </tr>
            <tr>
              <td style="padding:16px 28px 24px;border-top:1px solid ${BRAND.border};">
                <p style="margin:0 0 6px;font-size:12px;line-height:18px;color:${BRAND.muted};">
                  Need help? Contact us at
                  <a href="mailto:${esc(parts.supportEmail)}" style="color:${BRAND.color};text-decoration:none;">${esc(
                    parts.supportEmail,
                  )}</a>.
                </p>
                <p style="margin:0;font-size:12px;line-height:18px;color:${BRAND.muted};">
                  You received this email because of activity on your ${BRAND.name} account. If it wasn't you, contact support.
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

/** Join text lines with blank-line spacing and a signed footer. */
function plain(lines: string[], supportEmail: string): string {
  return (
    lines.join("\n\n") +
    `\n\n—\nNeed help? Contact ${supportEmail}\nYou received this because of activity on your ${BRAND.name} account.`
  );
}

// ---------------------------------------------------------------------------
// 1. Verification code — confirm a NEW email address.
// ---------------------------------------------------------------------------
export function verificationCodeEmail(code: string, supportEmail = DEFAULT_SUPPORT_EMAIL): RenderedEmail {
  return {
    subject: `${code} is your ${BRAND.name} verification code`,
    html: layout({
      preview: `Your code is ${code}. It expires in 10 minutes.`,
      heading: "Confirm your email address",
      paragraphs: [
        "Enter this code in the app to confirm this email address on your account:",
        "The code expires in 10 minutes.",
      ],
      code,
      note: "If you didn't request this, you can ignore this email — your address has not been changed.",
      supportEmail,
    }),
    text: plain(
      [
        `Your ${BRAND.name} verification code is ${code}.`,
        "Enter it in the app to confirm this email address. It expires in 10 minutes.",
        "If you didn't request this, ignore this email — your address has not been changed.",
      ],
      supportEmail,
    ),
  };
}

// ---------------------------------------------------------------------------
// 2. Security code — "confirm it's you" before a sensitive action.
// ---------------------------------------------------------------------------
export function securityCodeEmail(code: string, supportEmail = DEFAULT_SUPPORT_EMAIL): RenderedEmail {
  return {
    subject: `${code} is your ${BRAND.name} security code`,
    html: layout({
      preview: `Your security code is ${code}. It expires in 10 minutes.`,
      heading: "Confirm it's you",
      paragraphs: [
        "We asked for this because someone is trying to change or delete your account. Enter this code in the app to continue:",
        "The code expires in 10 minutes.",
      ],
      code,
      note: "If this wasn't you, do NOT share this code — and change your password right away.",
      supportEmail,
    }),
    text: plain(
      [
        `Your ${BRAND.name} security code is ${code}.`,
        "We asked for this because someone is trying to change or delete your account. Enter it in the app to continue. It expires in 10 minutes.",
        "If this wasn't you, do not share this code and change your password immediately.",
      ],
      supportEmail,
    ),
  };
}

// ---------------------------------------------------------------------------
// 3. Security alert — the email or phone was changed (goes to the OLD one).
// ---------------------------------------------------------------------------
export function identifierChangedEmail(
  kind: "email" | "phone",
  maskedNew: string,
  supportEmail = DEFAULT_SUPPORT_EMAIL,
): RenderedEmail {
  const label = kind === "email" ? "email address" : "phone number";
  return {
    subject: `Your ${BRAND.name} ${label} was changed`,
    html: layout({
      preview: `The ${label} on your account was changed to ${maskedNew}.`,
      heading: `Your ${label} was changed`,
      paragraphs: [
        `The ${label} on your ${BRAND.name} account was just changed to <b>${esc(maskedNew)}</b>.`,
        "If you made this change, no action is needed.",
      ],
      note: `If you did NOT do this, someone may have access to your account — contact support immediately and change your password.`,
      supportEmail,
    }),
    text: plain(
      [
        `The ${label} on your ${BRAND.name} account was just changed to ${maskedNew}.`,
        "If you made this change, no action is needed.",
        "If you did NOT, someone may have access to your account — contact support immediately and change your password.",
      ],
      supportEmail,
    ),
  };
}

// ---------------------------------------------------------------------------
// 4. Welcome — after a new account finishes signup.
// ---------------------------------------------------------------------------
export function welcomeEmail(
  name: string,
  opts: { appUrl?: string; supportEmail?: string } = {},
): RenderedEmail {
  const supportEmail = opts.supportEmail || DEFAULT_SUPPORT_EMAIL;
  // Raw here on purpose: `layout()` escapes the heading. Pre-escaping would make
  // it double-escaped, so a name with a `<` would render as literal `&lt;`.
  const who = name || "there";
  return {
    subject: `Welcome to ${BRAND.name}!`,
    html: layout({
      preview: `Your ${BRAND.name} account is ready. Jump into your first battle.`,
      heading: `Welcome, ${who}!`,
      paragraphs: [
        `Your ${BRAND.name} account is ready. Enter photo and video battles, win coins, and climb the leaderboard.`,
        "Tap below to open the app and start your first battle.",
      ],
      cta: opts.appUrl ? { label: "Open TopHunt", url: opts.appUrl } : undefined,
      supportEmail,
    }),
    text: plain(
      [
        `Welcome to ${BRAND.name}, ${name || "there"}!`,
        "Your account is ready. Enter photo and video battles, win coins, and climb the leaderboard.",
        ...(opts.appUrl ? [`Open the app: ${opts.appUrl}`] : []),
      ],
      supportEmail,
    ),
  };
}

// ---------------------------------------------------------------------------
// 5. Account deletion scheduled — with the date it can still be cancelled by.
// ---------------------------------------------------------------------------
export function accountDeletionScheduledEmail(
  whenText: string,
  supportEmail = DEFAULT_SUPPORT_EMAIL,
): RenderedEmail {
  const dated = whenText ? ` on <b>${esc(whenText)}</b>` : "";
  const datedText = whenText ? ` on ${whenText}` : "";
  return {
    subject: `Your ${BRAND.name} account is scheduled for deletion`,
    html: layout({
      preview: `Your account will be permanently deleted${datedText}. Sign in before then to cancel.`,
      heading: "Your account is scheduled for deletion",
      paragraphs: [
        `We've received your request to delete your ${BRAND.name} account. It is now closed, and will be permanently deleted${dated}.`,
        "Changed your mind? Sign in before that date and choose to keep your account — everything comes back.",
      ],
      note: "If you did NOT request this, sign in now to cancel it and change your password — someone may have access to your account.",
      supportEmail,
    }),
    text: plain(
      [
        `We've received your request to delete your ${BRAND.name} account. It is now closed and will be permanently deleted${datedText}.`,
        "Changed your mind? Sign in before that date and choose to keep your account — everything comes back.",
        "If you did NOT request this, sign in now to cancel it and change your password.",
      ],
      supportEmail,
    ),
  };
}

// ---------------------------------------------------------------------------
// 6. Admin test — the "Test connection" probe on the Integrations page.
// ---------------------------------------------------------------------------
export function testEmail(supportEmail = DEFAULT_SUPPORT_EMAIL): RenderedEmail {
  return {
    subject: `${BRAND.name} email test`,
    html: layout({
      preview: "Transactional email is working.",
      heading: "It works ✅",
      paragraphs: [
        "This is a test from the TopHunt admin panel.",
        "If you received it, your transactional email provider is configured correctly.",
      ],
      supportEmail,
    }),
    text: plain(
      [
        "This is a test from the TopHunt admin panel.",
        "If you received it, your transactional email provider is configured correctly.",
      ],
      supportEmail,
    ),
  };
}


// ---------------------------------------------------------------------------
// 7. Coins added — a top-up / manual deposit was credited to the wallet.
// ---------------------------------------------------------------------------
export function coinsAddedEmail(coins: number | null | undefined, supportEmail = DEFAULT_SUPPORT_EMAIL): RenderedEmail {
  const n = Math.round(Number(coins) || 0);
  return {
    subject: `${n} Dpcoins added to your ${BRAND.name} wallet`,
    html: layout({
      preview: `${n} Dpcoins are now in your wallet.`,
      heading: "Coins added 🎉",
      paragraphs: [
        `<b>${esc(n)} Dpcoins</b> have been added to your ${BRAND.name} wallet.`,
        "You can use them to enter battles right away. This email is your receipt for the top-up.",
      ],
      note: "If you did NOT make this purchase, contact support immediately.",
      supportEmail,
    }),
    text: plain(
      [
        `${n} Dpcoins have been added to your ${BRAND.name} wallet.`,
        "You can use them to enter battles right away. This email is your receipt for the top-up.",
        "If you did NOT make this purchase, contact support immediately.",
      ],
      supportEmail,
    ),
  };
}

// ---------------------------------------------------------------------------
// 8. Coins reversed — a payment was refunded / charged back, coins pulled back.
// ---------------------------------------------------------------------------
export function coinsReversedEmail(
  coins: number | null | undefined,
  reason: string | null | undefined,
  supportEmail = DEFAULT_SUPPORT_EMAIL,
): RenderedEmail {
  const n = Math.round(Number(coins) || 0);
  const why = reason ? ` because a payment was ${reason}` : "";
  return {
    subject: `${n} Dpcoins were reversed on your ${BRAND.name} wallet`,
    html: layout({
      preview: `${n} Dpcoins were removed from your wallet.`,
      heading: "Coins reversed",
      paragraphs: [
        `<b>${esc(n)} Dpcoins</b> have been removed from your ${BRAND.name} wallet${esc(why)}.`,
        "If this pushed your balance below zero, top up to bring it back to positive before you can withdraw again.",
      ],
      note: "Think this is a mistake? Reply to your bank about the original charge, then contact us so we can help.",
      supportEmail,
    }),
    text: plain(
      [
        `${n} Dpcoins have been removed from your ${BRAND.name} wallet${why}.`,
        "If this pushed your balance below zero, top up to bring it back to positive before you can withdraw again.",
        "Think this is a mistake? Contact us so we can help.",
      ],
      supportEmail,
    ),
  };
}

// ---------------------------------------------------------------------------
// 9. Withdrawal decision — payout approved / paid / rejected.
// ---------------------------------------------------------------------------
export function withdrawalDecisionEmail(
  status: "approved" | "paid" | "rejected",
  amount: number | null | undefined,
  note: string | null | undefined = "",
  supportEmail = DEFAULT_SUPPORT_EMAIL,
): RenderedEmail {
  const n = Math.round(Number(amount) || 0);
  if (status === "rejected") {
    return {
      subject: `Your ${BRAND.name} payout request was rejected`,
      html: layout({
        preview: `Your payout of ${n} Dpcoins was not approved.`,
        heading: "Payout request rejected",
        paragraphs: [
          `Your request to withdraw <b>${esc(n)} Dpcoins</b> was not approved, and the coins have been returned to your wallet.`,
          ...(note ? [`Reason: ${esc(note)}`] : []),
          "You can raise a new request from the wallet screen once any issue is resolved.",
        ],
        supportEmail,
      }),
      text: plain(
        [
          `Your request to withdraw ${n} Dpcoins was not approved, and the coins have been returned to your wallet.`,
          ...(note ? [`Reason: ${note}`] : []),
          "You can raise a new request from the wallet screen once any issue is resolved.",
        ],
        supportEmail,
      ),
    };
  }
  const paid = status === "paid";
  return {
    subject: paid ? `Your ${BRAND.name} payout has been sent 💸` : `Your ${BRAND.name} payout was approved`,
    html: layout({
      preview: paid
        ? `Your payout of ${n} Dpcoins has been sent.`
        : `Your payout of ${n} Dpcoins was approved and is being processed.`,
      heading: paid ? "Payout sent 💸" : "Payout approved",
      paragraphs: paid
        ? [
            `Your payout of <b>${esc(n)} Dpcoins</b> has been sent to your registered account.`,
            "Depending on your bank or UPI provider it can take a little while to appear. This email is your receipt.",
          ]
        : [
            `Your request to withdraw <b>${esc(n)} Dpcoins</b> was approved and is now being processed.`,
            "We'll let you know once the money is on its way.",
          ],
      supportEmail,
    }),
    text: plain(
      paid
        ? [
            `Your payout of ${n} Dpcoins has been sent to your registered account.`,
            "Depending on your bank or UPI provider it can take a little while to appear. This email is your receipt.",
          ]
        : [
            `Your request to withdraw ${n} Dpcoins was approved and is now being processed.`,
            "We'll let you know once the money is on its way.",
          ],
      supportEmail,
    ),
  };
}

// ---------------------------------------------------------------------------
// 10. Contest win — won a battle, with the prize credited.
// ---------------------------------------------------------------------------
export function contestWinEmail(
  battleTitle: string | null | undefined,
  coins: number | null | undefined,
  supportEmail = DEFAULT_SUPPORT_EMAIL,
): RenderedEmail {
  const n = Math.round(Number(coins) || 0);
  const title = battleTitle || "your battle";
  return {
    subject: `You won! ${n} Dpcoins added on ${BRAND.name} 🏆`,
    html: layout({
      preview: `You won "${title}" and earned ${n} Dpcoins.`,
      heading: "You won! 🏆",
      paragraphs: [
        `Congratulations — you won the battle <b>"${esc(title)}"</b>.`,
        `<b>${esc(n)} Dpcoins</b> have been added to your wallet as your prize. This email is your receipt.`,
        "Keep the streak going — enter your next battle from the app.",
      ],
      supportEmail,
    }),
    text: plain(
      [
        `Congratulations — you won the battle "${title}".`,
        `${n} Dpcoins have been added to your wallet as your prize. This email is your receipt.`,
        "Keep the streak going — enter your next battle from the app.",
      ],
      supportEmail,
    ),
  };
}

// ---------------------------------------------------------------------------
// 11. Contest refund — a battle voided / tied / cancelled; entry fee returned.
// ---------------------------------------------------------------------------
export function contestRefundEmail(
  battleTitle: string | null | undefined,
  reason: string | null | undefined,
  supportEmail = DEFAULT_SUPPORT_EMAIL,
): RenderedEmail {
  const title = battleTitle || "your battle";
  const why = reason || "the battle did not complete";
  return {
    subject: `Your ${BRAND.name} entry fee was refunded`,
    html: layout({
      preview: `Your entry fee for "${title}" was refunded.`,
      heading: "Entry fee refunded",
      paragraphs: [
        `The battle <b>"${esc(title)}"</b> did not complete — ${esc(why)}.`,
        "Your entry fee has been refunded to your wallet in full. This email is your receipt.",
      ],
      supportEmail,
    }),
    text: plain(
      [
        `The battle "${title}" did not complete — ${why}.`,
        "Your entry fee has been refunded to your wallet in full. This email is your receipt.",
      ],
      supportEmail,
    ),
  };
}

// ---------------------------------------------------------------------------
// 12. Password changed — security alert after the password was changed.
// ---------------------------------------------------------------------------
export function passwordChangedEmail(supportEmail = DEFAULT_SUPPORT_EMAIL): RenderedEmail {
  return {
    subject: `Your ${BRAND.name} password was changed`,
    html: layout({
      preview: "The password on your account was just changed.",
      heading: "Your password was changed",
      paragraphs: [
        `The password on your ${BRAND.name} account was just changed.`,
        "If you made this change, no action is needed.",
      ],
      note: "If you did NOT change it, someone may have access to your account — reset your password immediately and contact support.",
      supportEmail,
    }),
    text: plain(
      [
        `The password on your ${BRAND.name} account was just changed.`,
        "If you made this change, no action is needed.",
        "If you did NOT change it, someone may have access to your account — reset your password immediately and contact support.",
      ],
      supportEmail,
    ),
  };
}
