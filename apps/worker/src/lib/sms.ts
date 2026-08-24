import type { Env } from "../types";
import { getIntegrations, resolveSecret } from "./integrations";

/**
 * SMS delivery across interchangeable gateways.
 *
 * Previously this was Twilio only, hard-wired to environment variables — so
 * switching gateway meant a code change and a deploy. Indian OTP traffic is
 * usually cheaper on a domestic DLT-registered gateway, and operators change
 * providers for price and deliverability reasons, so the provider is now a
 * setting rather than a code path.
 *
 * Every provider returns the same shape so callers do not care which is active,
 * and `sendSms` never throws: a failed OTP send must not turn into a 500 on the
 * signup screen. Failures are reported to the caller as `ok: false` with a
 * reason, which the OTP flow surfaces as "could not send, try again".
 */

export interface SmsResult {
  ok: boolean;
  provider: string;
  /** Provider message/queue id when available — useful for support tickets. */
  id?: string;
  error?: string;
}

interface SendInput {
  to: string;
  message: string;
  /** The bare code, for gateways that send a template + variables. */
  code?: string;
}

/** E.164 for international gateways; bare 10 digits for Indian ones. */
function toE164(to: string): string {
  const digits = to.replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) return digits;
  if (digits.length === 10) return `+91${digits}`;
  return `+${digits}`;
}

function toIndianLocal(to: string): string {
  const digits = to.replace(/\D/g, "");
  return digits.length > 10 ? digits.slice(-10) : digits;
}

async function sendViaTwilio(env: Env, cfg: Awaited<ReturnType<typeof getIntegrations>>, input: SendInput): Promise<SmsResult> {
  const [sid, token] = await Promise.all([
    resolveSecret(env, "TWILIO_ACCOUNT_SID"),
    resolveSecret(env, "TWILIO_AUTH_TOKEN"),
  ]);
  const from = cfg.sms.from || (env.TWILIO_PHONE_NUMBER || "").trim();
  if (!sid || !token || !from) {
    return { ok: false, provider: "twilio", error: "Twilio is not fully configured (SID, token and sender number required)." };
  }
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${sid}:${token}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ To: toE164(input.to), From: from, Body: input.message }),
  });
  const text = await res.text();
  if (!res.ok) return { ok: false, provider: "twilio", error: `Twilio ${res.status}: ${text.slice(0, 300)}` };
  let id: string | undefined;
  try {
    id = JSON.parse(text)?.sid;
  } catch {
    /* not fatal */
  }
  return { ok: true, provider: "twilio", id };
}

async function sendViaMsg91(env: Env, cfg: Awaited<ReturnType<typeof getIntegrations>>, input: SendInput): Promise<SmsResult> {
  const key = await resolveSecret(env, "MSG91_AUTH_KEY");
  if (!key) return { ok: false, provider: "msg91", error: "MSG91 auth key is not configured." };
  if (!cfg.sms.templateId) return { ok: false, provider: "msg91", error: "MSG91 flow/template ID is not configured." };

  // MSG91's flow API sends a DLT-approved template with variables, which is what
  // Indian regulation requires — the raw message body is not sent.
  const res = await fetch("https://control.msg91.com/api/v5/flow/", {
    method: "POST",
    headers: { authkey: key, "Content-Type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      template_id: cfg.sms.templateId,
      short_url: "0",
      recipients: [
        {
          mobiles: `91${toIndianLocal(input.to)}`,
          [cfg.sms.otpVariable || "otp"]: input.code ?? input.message,
        },
      ],
    }),
  });
  const text = await res.text();
  // MSG91 answers 200 with {type:"error"} on some failures, so the body matters.
  let payload: any = null;
  try {
    payload = JSON.parse(text);
  } catch {
    /* treat as opaque */
  }
  if (!res.ok || payload?.type === "error") {
    return { ok: false, provider: "msg91", error: `MSG91: ${payload?.message || text.slice(0, 300)}` };
  }
  return { ok: true, provider: "msg91", id: payload?.request_id };
}

async function sendViaFast2Sms(env: Env, cfg: Awaited<ReturnType<typeof getIntegrations>>, input: SendInput): Promise<SmsResult> {
  const key = await resolveSecret(env, "FAST2SMS_API_KEY");
  if (!key) return { ok: false, provider: "fast2sms", error: "Fast2SMS API key is not configured." };

  const params: Record<string, string> = {
    route: cfg.sms.route || "dlt",
    numbers: toIndianLocal(input.to),
  };
  if (params.route === "otp") {
    params.variables_values = input.code ?? input.message;
  } else if (params.route === "dlt") {
    params.sender_id = cfg.sms.from;
    params.template_id = cfg.sms.templateId;
    params.variables_values = input.code ?? input.message;
  } else {
    params.sender_id = cfg.sms.from;
    params.message = input.message;
    params.language = "english";
  }

  const res = await fetch("https://www.fast2sms.com/dev/bulkV2", {
    method: "POST",
    headers: { authorization: key, "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  const text = await res.text();
  let payload: any = null;
  try {
    payload = JSON.parse(text);
  } catch {
    /* opaque */
  }
  if (!res.ok || payload?.return === false) {
    return { ok: false, provider: "fast2sms", error: `Fast2SMS: ${payload?.message || text.slice(0, 300)}` };
  }
  return { ok: true, provider: "fast2sms", id: payload?.request_id };
}

async function sendViaCustom(env: Env, cfg: Awaited<ReturnType<typeof getIntegrations>>, input: SendInput): Promise<SmsResult> {
  const token = (await resolveSecret(env, "SMS_CUSTOM_TOKEN")) ?? "";
  const url = cfg.sms.customUrl;
  if (!url) return { ok: false, provider: "custom", error: "Custom gateway URL is not configured." };

  // Placeholders are URL-encoded for the query string and JSON-escaped for the
  // body, so a message containing `&` or a quote cannot break the request.
  const fill = (template: string, encode: (v: string) => string) =>
    template
      .replace(/\{to\}/g, encode(toIndianLocal(input.to)))
      .replace(/\{to_e164\}/g, encode(toE164(input.to)))
      .replace(/\{message\}/g, encode(input.message))
      .replace(/\{code\}/g, encode(input.code ?? ""))
      .replace(/\{token\}/g, encode(token));

  const target = fill(url, encodeURIComponent);
  const init: RequestInit =
    cfg.sms.customMethod === "POST"
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: cfg.sms.customBody
            ? fill(cfg.sms.customBody, (v) => JSON.stringify(v).slice(1, -1))
            : JSON.stringify({ to: toIndianLocal(input.to), message: input.message }),
        }
      : { method: "GET" };

  const res = await fetch(target, init);
  const text = await res.text();
  if (!res.ok) return { ok: false, provider: "custom", error: `Gateway ${res.status}: ${text.slice(0, 300)}` };
  return { ok: true, provider: "custom" };
}

/**
 * Send an SMS through whichever gateway is configured.
 *
 * Never throws. Returns `{ ok: false, error }` so the caller decides whether an
 * undelivered OTP is fatal for that flow.
 */
export async function sendSmsDetailed(env: Env, to: string, message: string, code?: string): Promise<SmsResult> {
  try {
    const cfg = await getIntegrations(env);
    const input: SendInput = { to, message, code };
    switch (cfg.sms.provider) {
      case "twilio":
        return await sendViaTwilio(env, cfg, input);
      case "msg91":
        return await sendViaMsg91(env, cfg, input);
      case "fast2sms":
        return await sendViaFast2Sms(env, cfg, input);
      case "custom":
        return await sendViaCustom(env, cfg, input);
      case "none":
      default: {
        // Backwards compatibility: a deployment that has Twilio env vars but has
        // never opened the new settings page keeps working exactly as before.
        const sid = await resolveSecret(env, "TWILIO_ACCOUNT_SID");
        if (sid) return await sendViaTwilio(env, cfg, input);
        return { ok: false, provider: "none", error: "No SMS gateway is configured." };
      }
    }
  } catch (e: any) {
    console.error("[sms] send failed", e);
    return { ok: false, provider: "unknown", error: e?.message || "SMS send failed." };
  }
}

/** Backwards-compatible boolean wrapper used by the existing auth flows. */
export async function sendSms(env: Env, to: string, body: string, code?: string): Promise<boolean> {
  const result = await sendSmsDetailed(env, to, body, code);
  if (!result.ok) console.error(`[sms] ${result.provider}: ${result.error}`);
  return result.ok;
}

/** Is any gateway usable right now? Used by the deep health check. */
export async function smsConfigured(env: Env): Promise<boolean> {
  const cfg = await getIntegrations(env);
  switch (cfg.sms.provider) {
    case "twilio":
      return !!(await resolveSecret(env, "TWILIO_AUTH_TOKEN")) && !!cfg.sms.from;
    case "msg91":
      return !!(await resolveSecret(env, "MSG91_AUTH_KEY")) && !!cfg.sms.templateId;
    case "fast2sms":
      return !!(await resolveSecret(env, "FAST2SMS_API_KEY"));
    case "custom":
      return !!cfg.sms.customUrl;
    default:
      return !!(await resolveSecret(env, "TWILIO_AUTH_TOKEN"));
  }
}
