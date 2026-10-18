/**
 * The app's first-launch intro, as an admin configures it (App config keys
 * `onboarding` and `onboardingEnabled`).
 *
 * Read by every new guest's app via the public `/read/app-config`, so it is
 * validated on the way in: bounded text, a bounded number of slides, and images
 * only from this deployment's own media storage under `onboarding/` (uploaded
 * through `POST /admin/media/onboarding-image`). A slide with no image falls back
 * to the app's built-in art for that position.
 */
import type { Env } from "../types";
import { httpsError } from "./http";
import { mediaKeyFromPublicUrl } from "./r2";
import { ONBOARDING_IMAGE_PREFIX } from "./mediaCategories";

export const ONBOARDING_MAX_SLIDES = 6;
export const ONBOARDING_TITLE_MAX = 60;
export const ONBOARDING_DESCRIPTION_MAX = 200;

export interface OnboardingSlide {
  title: string;
  description: string;
  /** Owned media URL under `onboarding/`, or "" for the app's built-in art. */
  imageUrl: string;
}

function text(value: unknown, field: string, max: number, index: number): string {
  if (value == null) return "";
  if (typeof value !== "string") throw httpsError("invalid-argument", `Slide ${index + 1}: ${field} must be text.`);
  // Collapse whitespace runs (and strip control characters) so a pasted
  // paragraph cannot blow the layout up with stray newlines.
  const clean = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (clean.length > max) {
    throw httpsError("invalid-argument", `Slide ${index + 1}: ${field} must be at most ${max} characters.`);
  }
  return clean;
}

/**
 * Validate and normalise an admin-submitted slide list. Throws `invalid-argument`
 * with a message naming the slide and field, so the panel can show it as is.
 */
export function sanitizeOnboardingSlides(env: Env, input: unknown): OnboardingSlide[] {
  if (!Array.isArray(input)) throw httpsError("invalid-argument", "onboarding must be a list of slides.");
  if (input.length > ONBOARDING_MAX_SLIDES) {
    throw httpsError("invalid-argument", `At most ${ONBOARDING_MAX_SLIDES} onboarding slides.`);
  }
  return input.map((raw, i) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw httpsError("invalid-argument", `Slide ${i + 1} is not valid.`);
    }
    const r = raw as Record<string, unknown>;
    const title = text(r.title, "title", ONBOARDING_TITLE_MAX, i);
    const description = text(r.description, "description", ONBOARDING_DESCRIPTION_MAX, i);
    if (!title) throw httpsError("invalid-argument", `Slide ${i + 1}: title is required.`);
    let imageUrl = "";
    if (r.imageUrl != null && String(r.imageUrl).trim() !== "") {
      const url = String(r.imageUrl).trim();
      const key = mediaKeyFromPublicUrl(env, url);
      if (!url.startsWith("https://") || !key || !key.startsWith(`${ONBOARDING_IMAGE_PREFIX}/`)) {
        throw httpsError(
          "invalid-argument",
          `Slide ${i + 1}: the image must be uploaded from the admin panel.`,
        );
      }
      imageUrl = url;
    }
    return { title, description, imageUrl };
  });
}

/** The intro is on unless an admin explicitly switched it off. */
export function onboardingEnabled(config: Record<string, any> | null | undefined): boolean {
  return config?.onboardingEnabled !== false;
}
