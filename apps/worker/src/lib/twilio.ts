/**
 * Twilio SMS via REST (replaces the twilio node client, which can't run on
 * Workers). If credentials are missing we log and no-op, matching the old
 * behaviour of generating the OTP without sending.
 */
import type { Env } from "../types";

export async function sendSms(env: Env, to: string, body: string): Promise<boolean> {
  const sid = env.TWILIO_ACCOUNT_SID;
  const token = env.TWILIO_AUTH_TOKEN;
  const from = env.TWILIO_PHONE_NUMBER;
  if (!sid || !token || !from) {
    console.warn("[twilio] credentials missing; SMS not sent");
    return false;
  }
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${sid}:${token}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ To: to, From: from, Body: body }),
  });
  if (!res.ok) {
    console.error("[twilio] send failed", await res.text());
    return false;
  }
  return true;
}
