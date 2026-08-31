/**
 * Transactional email over HTTP (Workers have no raw TCP, so no SMTP).
 *
 * The provider and the From address are admin-panel settings rather than
 * environment variables, so switching provider — or fixing a From address that a
 * domain change invalidated — does not need a deploy. Credentials still live
 * encrypted (lib/integrations.ts), never in plain config.
 */
import type { Env } from "../types";
import { getIntegrations, resolveSecret } from "./integrations";

export interface EmailResult {
  ok: boolean;
  provider: string;
  id?: string;
  error?: string;
}

interface SendOpts {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

const FALLBACK_FROM = "TopHunt <no-reply@tophunt.in>";

async function sendViaResend(env: Env, from: string, replyTo: string, opts: SendOpts): Promise<EmailResult> {
  const key = await resolveSecret(env, "RESEND_API_KEY");
  if (!key) return { ok: false, provider: "resend", error: "Resend API key is not configured." };
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from,
      to: [opts.to],
      subject: opts.subject,
      html: opts.html,
      text: opts.text,
      ...(replyTo ? { reply_to: replyTo } : {}),
    }),
  });
  const body = await res.text();
  if (!res.ok) return { ok: false, provider: "resend", error: `Resend ${res.status}: ${body.slice(0, 300)}` };
  let id: string | undefined;
  try {
    id = JSON.parse(body)?.id;
  } catch {
    /* not fatal */
  }
  return { ok: true, provider: "resend", id };
}

/** Parse `Name <a@b.com>` or a bare address into Brevo's structured sender. */
function parseAddress(value: string): { email: string; name?: string } {
  const match = value.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  if (match) return { name: match[1] || undefined, email: match[2].trim() };
  return { email: value.trim() };
}

async function sendViaBrevo(env: Env, from: string, replyTo: string, opts: SendOpts): Promise<EmailResult> {
  const key = await resolveSecret(env, "BREVO_API_KEY");
  if (!key) return { ok: false, provider: "brevo", error: "Brevo API key is not configured." };
  const res = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "api-key": key, "Content-Type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      sender: parseAddress(from),
      to: [{ email: opts.to }],
      subject: opts.subject,
      htmlContent: opts.html,
      textContent: opts.text,
      ...(replyTo ? { replyTo: parseAddress(replyTo) } : {}),
    }),
  });
  const body = await res.text();
  if (!res.ok) return { ok: false, provider: "brevo", error: `Brevo ${res.status}: ${body.slice(0, 300)}` };
  let id: string | undefined;
  try {
    id = JSON.parse(body)?.messageId;
  } catch {
    /* not fatal */
  }
  return { ok: true, provider: "brevo", id };
}

/**
 * Maileroo (smtp.maileroo.com) — HTTP email API.
 *
 * Contract, from the provider's docs: POST multipart/form-data to
 * `https://smtp.maileroo.com/send`, authenticated with an `X-API-Key` header.
 * Fields are `from` ("Name <addr>"), `to`, `subject`, and at least one of `html`
 * / `plain`. The response is JSON `{ success, message, data }`, so — like the SMS
 * gateways — an HTTP 200 carrying `success: false` is treated as the failure it
 * is rather than reported as sent.
 */
async function sendViaMaileroo(env: Env, from: string, replyTo: string, opts: SendOpts): Promise<EmailResult> {
  const key = await resolveSecret(env, "MAILEROO_API_KEY");
  if (!key) return { ok: false, provider: "maileroo", error: "Maileroo API key is not configured." };

  const form = new FormData();
  form.append("from", from);
  form.append("to", opts.to);
  form.append("subject", opts.subject);
  form.append("html", opts.html);
  // Maileroo needs at least one body; we always have html, plain is a bonus.
  if (opts.text) form.append("plain", opts.text);
  if (replyTo) form.append("reply_to", replyTo);

  const res = await fetch("https://smtp.maileroo.com/send", {
    method: "POST",
    headers: { "X-API-Key": key },
    body: form,
  });
  const body = await res.text();
  let payload: any = null;
  try {
    payload = JSON.parse(body);
  } catch {
    /* opaque body — fall back to the status code below */
  }
  if (!res.ok || payload?.success === false) {
    return { ok: false, provider: "maileroo", error: `Maileroo: ${payload?.message || body.slice(0, 300)}` };
  }
  const id = payload?.data?.reference_id || payload?.reference_id || payload?.data?.id;
  return { ok: true, provider: "maileroo", id: id ? String(id) : undefined };
}

/** Send an email through the configured provider. Never throws. */
export async function sendEmailDetailed(env: Env, opts: SendOpts): Promise<EmailResult> {
  try {
    const cfg = await getIntegrations(env);
    const from = cfg.email.from || (env.EMAIL_FROM || "").trim() || FALLBACK_FROM;
    const replyTo = cfg.email.replyTo;
    switch (cfg.email.provider) {
      case "resend":
        return await sendViaResend(env, from, replyTo, opts);
      case "brevo":
        return await sendViaBrevo(env, from, replyTo, opts);
      case "maileroo":
        return await sendViaMaileroo(env, from, replyTo, opts);
      case "none":
      default: {
        // Unconfigured provider but a Resend key present = a deployment that
        // predates these settings. Keep working.
        if (await resolveSecret(env, "RESEND_API_KEY")) {
          return await sendViaResend(env, from, replyTo, opts);
        }
        return { ok: false, provider: "none", error: "No email provider is configured." };
      }
    }
  } catch (e: any) {
    console.error("[email] send failed", e);
    return { ok: false, provider: "unknown", error: e?.message || "Email send failed." };
  }
}

/** Backwards-compatible boolean wrapper used by the existing auth flows. */
export async function sendEmail(
  env: Env,
  opts: SendOpts,
): Promise<boolean> {
  const result = await sendEmailDetailed(env, opts);
  if (!result.ok) console.error(`[email] ${result.provider}: ${result.error}`);
  return result.ok;
}

export async function emailConfigured(env: Env): Promise<boolean> {
  const cfg = await getIntegrations(env);
  if (cfg.email.provider === "brevo") return !!(await resolveSecret(env, "BREVO_API_KEY"));
  if (cfg.email.provider === "maileroo") return !!(await resolveSecret(env, "MAILEROO_API_KEY"));
  return !!(await resolveSecret(env, "RESEND_API_KEY"));
}
