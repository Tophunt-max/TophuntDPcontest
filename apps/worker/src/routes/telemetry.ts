/**
 * /telemetry — anonymous, aggregate product counters that guests may send.
 *
 * Only the onboarding funnel for now (migration 0058). Unauthenticated by
 * design: the intro is shown to people who have no account yet. What keeps it
 * honest:
 *  - nothing identifying is stored — one counter per (day, event, slide, platform);
 *  - input is a closed set (event names, slide 0..5, platform enum); anything
 *    else is a 400;
 *  - per-IP budget (120/hour). Over budget the request still answers 204 but
 *    is not counted, so a script learns nothing and cannot inflate the numbers
 *    much. The limiter fails open: a counter is not worth an outage.
 */
import { Hono } from "hono";
import type { Env, Variables } from "../types";
import { httpsError } from "../lib/http";
import { clientIp, consumeRateLimit } from "../lib/rateLimit";
import { ONBOARDING_MAX_SLIDES } from "../lib/onboardingConfig";

export const telemetryRoute = new Hono<{ Bindings: Env; Variables: Variables }>();

export const ONBOARDING_EVENTS = ["shown", "reached", "skipped", "completed", "login"] as const;
export type OnboardingEvent = (typeof ONBOARDING_EVENTS)[number];
const PLATFORMS = new Set(["ios", "android", "web"]);
/** Events that are about a particular slide; the others are stored with slide -1. */
const SLIDE_EVENTS = new Set<OnboardingEvent>(["reached", "skipped", "login"]);

export function utcDay(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

telemetryRoute.post("/onboarding", async (c) => {
  const body = await c.req.json<any>().catch(() => null);
  const event = body?.event as OnboardingEvent;
  if (!ONBOARDING_EVENTS.includes(event)) throw httpsError("invalid-argument", "Unknown event.");
  let slide = -1;
  if (SLIDE_EVENTS.has(event)) {
    const n = Number(body?.slide);
    if (!Number.isInteger(n) || n < 0 || n >= ONBOARDING_MAX_SLIDES) {
      throw httpsError("invalid-argument", "slide must be a slide index.");
    }
    slide = n;
  }
  const platform = PLATFORMS.has(body?.platform) ? String(body.platform) : "other";

  const allowed = await consumeRateLimit(c.env, `onbevt:${clientIp(c.req.raw.headers)}`, 120, 3600);
  if (allowed) {
    await c.env.DB.prepare(
      `INSERT INTO onboarding_daily (day, event, slide, platform, count) VALUES (?, ?, ?, ?, 1)
       ON CONFLICT (day, event, slide, platform) DO UPDATE SET count = count + 1`,
    )
      .bind(utcDay(Date.now()), event, slide, platform)
      .run();
  }
  return c.body(null, 204);
});
