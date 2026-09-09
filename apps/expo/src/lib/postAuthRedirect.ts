/**
 * Where to send a user after they sign in, when they arrived from a link.
 *
 * ---------------------------------------------------------------------------
 * Why this exists
 * ---------------------------------------------------------------------------
 * Public profiles moved to `/@handle`, and the screen behind that url still requires a
 * session. So every shared profile link now funnels anonymous visitors through
 * `/auth/login?redirect=/@handle` — which means the `redirect` parameter went from a
 * detail on one screen to the thing that decides whether shared links work at all.
 *
 * It was honoured on exactly one branch (email + password). Phone sign-in and the
 * social providers both landed on `/home`, discarding the link the visitor had followed
 * — and phone is the dominant method for this audience, so in practice "open a shared
 * profile link" ended at the home feed for most people.
 *
 * ---------------------------------------------------------------------------
 * Why it is sanitised rather than used as given
 * ---------------------------------------------------------------------------
 * `redirect` is attacker-controlled: it is a query parameter on an unauthenticated
 * page, and the value is handed to `router.replace`. On web that is a navigation, so an
 * absolute url would make `tophunt.in/auth/login?redirect=https://evil.example` send
 * users off-site FROM A REAL TOPHUNT LOGIN PAGE — the shape of a credible phishing
 * hop, since the domain the victim checked is genuine.
 *
 * The password branch previously passed the value straight through
 * (`router.replace(decodeURIComponent(redirect))`), so this closes that too.
 *
 * The rule is deliberately narrow: one leading slash, and nothing that could be read as
 * a scheme or a host. Anything else answers null and the caller falls back to `/home`.
 */

/** Paths a signed-in user must never be bounced back to. */
const NEVER_REDIRECT_TO = ['/auth', '/splash', '/onboarding'];

/**
 * Normalise a `redirect` query parameter to an in-app path, or null.
 *
 * Accepts the raw parameter in the shapes expo-router can produce (string, array when
 * the key is repeated, or undefined), and tolerates a value that was encoded more than
 * once — a redirect gets forwarded between screens, and each hop re-encodes it.
 */
export function sanitizeRedirect(raw: string | string[] | null | undefined): string | null {
  let value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return null;
  value = value.trim();
  if (!value) return null;

  // Undo repeated encoding, bounded so a crafted value cannot spin here.
  for (let i = 0; i < 3 && /%[0-9a-f]{2}/i.test(value); i += 1) {
    try {
      const decoded = decodeURIComponent(value);
      if (decoded === value) break;
      value = decoded;
    } catch {
      // Malformed escape — refuse rather than guess at what was meant.
      return null;
    }
  }

  // Must be a single-slash-rooted path. `//evil.example` is protocol-relative and
  // navigates off-site, and a backslash is treated as a slash by some url parsers.
  if (!value.startsWith('/')) return null;
  if (value.startsWith('//') || value.startsWith('/\\')) return null;
  // No scheme anywhere, and no control characters that could split the value.
  if (/[\u0000-\u001f\u007f]/.test(value)) return null;
  if (/^\/+[a-z][a-z0-9+.-]*:/i.test(value)) return null;

  // Bouncing back into the auth flow is a loop, and back to the splash screen throws
  // the destination away — both are worse than the home feed.
  const path = value.split(/[?#]/)[0].replace(/\/+$/, '') || '/';
  if (NEVER_REDIRECT_TO.some((p) => path === p || path.startsWith(`${p}/`))) return null;

  return value;
}

/** The post-sign-in destination for a returning user: their link, or the home feed. */
export function postAuthDestination(raw: string | string[] | null | undefined): string {
  return sanitizeRedirect(raw) ?? '/home';
}
