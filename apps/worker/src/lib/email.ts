/**
 * Transactional email. The old backend used Gmail SMTP via nodemailer, which
 * is NOT available on Workers (no raw TCP). This uses an HTTP email provider
 * (Resend by default). Swap the endpoint for SendGrid/Mailgun if preferred.
 */
import type { Env } from "../types";

export async function sendEmail(
  env: Env,
  opts: { to: string; subject: string; html: string; text?: string },
): Promise<boolean> {
  if (!env.RESEND_API_KEY) {
    console.warn("[email] RESEND_API_KEY missing; email not sent");
    return false;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: env.EMAIL_FROM || "TopHunt <no-reply@tophuntdpcontest.com>",
      to: [opts.to],
      subject: opts.subject,
      html: opts.html,
      text: opts.text,
    }),
  });
  if (!res.ok) {
    console.error("[email] send failed", await res.text());
    return false;
  }
  return true;
}
