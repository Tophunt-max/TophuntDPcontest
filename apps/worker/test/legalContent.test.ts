import { describe, it, expect, beforeEach } from "vitest";
import { resolveLegalContent, LEGAL_DOC_KEYS, LEGAL_LAST_UPDATED } from "../src/content/legal";
import { makeEnv, makeApp, fakeCtx, drizzleOf, type TestEnv } from "./helpers/harness";
import { schema } from "../src/db";

const app = makeApp();

/**
 * Guards the invariant that a legal document is never served empty.
 *
 * This is a regression test for a live production bug, not a unit test written for
 * coverage. `/read/app-config` used to project `cfg.legalContent?.x || ""`, and
 * nothing had ever been written to `settings/appConfig.legalContent`, so
 * tophunt.in/legal/terms, /legal/privacy and /legal/refund all rendered
 * "…has not been published yet." An empty privacy policy is an app-store rejection
 * reason and an empty refund policy is a Razorpay compliance gap, so the failure
 * needs to be caught here rather than by a reviewer.
 */
describe("legal content", () => {
  it("serves a substantial document for every key, whatever the config looks like", () => {
    const configs = [
      undefined,
      null,
      {},
      { legalContent: null },
      { legalContent: {} },
      // Whitespace is not content. This is the shape that would slip through a
      // plain `||` check.
      { legalContent: { termsOfService: "   \n  " } },
      // Wrong types must not throw or leak into the response.
      { legalContent: { privacyPolicy: 42, refundPolicy: [] } },
    ];

    for (const cfg of configs) {
      const out = resolveLegalContent(cfg);
      for (const key of LEGAL_DOC_KEYS) {
        expect(typeof out[key], `${key} is not a string for ${JSON.stringify(cfg)}`).toBe("string");
        expect(
          out[key].trim().length,
          `${key} is empty or stubbed for ${JSON.stringify(cfg)}`,
        ).toBeGreaterThan(500);
      }
    }
  });

  it("prefers admin content per document without dropping the others", () => {
    // The per-document fallback matters: an operator who writes their own Terms
    // must not thereby lose the bundled Privacy Policy.
    const out = resolveLegalContent({ legalContent: { termsOfService: "MY OWN TERMS" } });
    expect(out.termsOfService).toBe("MY OWN TERMS");
    expect(out.privacyPolicy.length).toBeGreaterThan(500);
    expect(out.refundPolicy.length).toBeGreaterThan(500);
    expect(out.communityGuidelines.length).toBeGreaterThan(500);
  });

  it("never leaks the support-email placeholder to the client", () => {
    const configured = resolveLegalContent({ supportEmail: "help@tophunt.in" });
    for (const key of LEGAL_DOC_KEYS) {
      expect(configured[key], `${key} still carries the raw token`).not.toContain("{{SUPPORT_EMAIL}}");
    }
    expect(configured.refundPolicy).toContain("help@tophunt.in");

    // No configured address still has to yield a real one, since the refund and
    // privacy documents both direct the reader to write to it.
    const fallback = resolveLegalContent({});
    for (const key of LEGAL_DOC_KEYS) {
      expect(fallback[key]).not.toContain("{{SUPPORT_EMAIL}}");
    }
    expect(fallback.privacyPolicy).toContain("support@tophunt.in");
  });

  it("interpolates the token inside admin-authored content too", () => {
    const out = resolveLegalContent({
      supportEmail: "ops@tophunt.in",
      legalContent: { refundPolicy: "Write to {{SUPPORT_EMAIL}} please." },
    });
    expect(out.refundPolicy).toBe("Write to ops@tophunt.in please.");
  });

  /**
   * The privacy policy states how long data survives a deletion request, and an
   * operator can change that number from the admin panel. A hardcoded figure would
   * become a false statement the first time anyone touched the setting — and this
   * is the one document where a false statement is a regulatory problem rather
   * than a typo.
   */
  it("states the configured deletion grace period, never the raw token", () => {
    const configured = resolveLegalContent({ accountDeletionGraceDays: 7 });
    expect(configured.privacyPolicy).toContain("grace period of 7 days");
    for (const key of LEGAL_DOC_KEYS) {
      expect(configured[key]).not.toContain("{{DELETION_GRACE_DAYS}}");
    }

    // Unset, or nonsense, falls back to the same default the server enforces.
    for (const cfg of [{}, { accountDeletionGraceDays: "soon" }, { accountDeletionGraceDays: null }]) {
      const out = resolveLegalContent(cfg);
      expect(out.privacyPolicy).toContain("grace period of 30 days");
      expect(out.privacyPolicy).not.toContain("{{DELETION_GRACE_DAYS}}");
    }

    // Clamped the same way lib/accountDeletion.ts clamps it, so the document can
    // never promise a window the server will not honour.
    expect(resolveLegalContent({ accountDeletionGraceDays: 900 }).privacyPolicy).toContain(
      "grace period of 90 days",
    );
  });

  /**
   * The policy used to say deletion was BLOCKED during an unfinished contest,
   * which described the old behaviour: the request was refused and the user was
   * told to come back later. Deletion is now always accepted and merely deferred,
   * so that sentence became untrue — and a privacy policy that overstates when we
   * refuse erasure is exactly the kind of claim a regulator reads closely.
   */
  it("does not claim deletion can be refused", () => {
    const out = resolveLegalContent({});
    expect(out.privacyPolicy).not.toContain("Deletion is blocked");
    expect(out.privacyPolicy).toContain("we still accept your deletion request");
  });

  /**
   * Everything lib/accountDeletion.ts retains has to be disclosed here. The
   * retention list in the deletion routine and the list in this document are two
   * copies of one fact, and the copy users read is this one.
   */
  it("discloses every category of retained data", () => {
    const out = resolveLegalContent({});
    for (const claim of [
      "Coin transactions",
      "Votes and contests",
      "Referral records",
      "Reports you filed",
      "Conversations you were part of",
      "Administrative audit records",
    ]) {
      expect(out.privacyPolicy, `privacy policy does not disclose: ${claim}`).toContain(claim);
    }
  });

  it("stamps every bundled document with the current revision date", () => {
    // The date is rendered as "Last updated" on each screen, so a document whose
    // text was edited without bumping the constant would display a stale date.
    const out = resolveLegalContent({});
    for (const key of LEGAL_DOC_KEYS) {
      expect(out[key], `${key} has no last-updated line`).toContain(LEGAL_LAST_UPDATED);
    }
  });
});


/**
 * The endpoint itself, over HTTP.
 *
 * `resolveLegalContent` being correct is necessary but not sufficient — the bug
 * that reached production was in the *projection*, not in any document. These
 * assertions are about the response a client actually receives.
 */
describe("GET /read/legal", () => {
  let env: TestEnv;

  beforeEach(() => {
    ({ env } = makeEnv());
  });

  const get = async (path: string) => {
    const res = await app.fetch(new Request(`https://api.test${path}`), env, fakeCtx());
    return { status: res.status, body: (await res.json()) as any };
  };

  const seedConfig = async (data: Record<string, unknown>) => {
    await drizzleOf(env)
      .insert(schema.settings)
      .values({ id: "appConfig", data, updatedAt: Date.now() } as any)
      .run();
  };

  it("serves all four documents on a database with no config row at all", async () => {
    // The exact production situation: nothing has ever been written to
    // settings/appConfig, and the app still has to render a policy.
    const { status, body } = await get("/read/legal");
    expect(status).toBe(200);
    for (const key of LEGAL_DOC_KEYS) {
      expect(body.legalContent[key].trim().length, `${key} came back empty`).toBeGreaterThan(500);
    }
  });

  it("does not require authentication", async () => {
    // A policy has to be readable before login, and by a crawler.
    const { status } = await get("/read/legal");
    expect(status).toBe(200);
  });

  it("lets an admin override one document and keeps the rest", async () => {
    await seedConfig({
      supportEmail: "care@tophunt.in",
      legalContent: { termsOfService: "CUSTOM TERMS" },
    });
    const { body } = await get("/read/legal");
    expect(body.legalContent.termsOfService).toBe("CUSTOM TERMS");
    expect(body.legalContent.privacyPolicy.length).toBeGreaterThan(500);
    expect(body.supportEmail).toBe("care@tophunt.in");
    expect(body.legalContent.refundPolicy).toContain("care@tophunt.in");
  });

  it("keeps the 28 KB of legal text out of /read/app-config", async () => {
    // app-config is polled app-wide for maintenance mode and feature flags. The
    // documents used to ride along on every one of those requests.
    const { status, body } = await get("/read/app-config");
    expect(status).toBe(200);
    expect(body.legalContent).toBeUndefined();
    // supportEmail stays — it is one short string and the Settings screen needs it.
    expect(body).toHaveProperty("supportEmail");
  });
});
