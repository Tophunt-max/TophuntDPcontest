/**
 * Remove a machine marker from the front of a server error message.
 *
 * The Worker signals a sub-reason by prefixing the message rather than inventing a new
 * error code, so that the HTTP status stays one the client already handles — `401` for a
 * revoked session, `412` for a required re-authentication. See `SESSION_REVOKED_CODE` and
 * `REAUTH_REQUIRED_CODE` on the server.
 *
 * The prefix is for code, not for people. Anywhere a message is rendered straight into a
 * toast, `session_revoked: You were signed out…` would reach the user verbatim, which
 * reads like a leaked internal string and undermines the message it is attached to.
 *
 * Only strips a leading `snake_case_token:` — the shape the server uses — so an ordinary
 * message containing a colon ("Entry closed: the contest has ended") is left alone.
 */
const MARKER = /^[a-z][a-z0-9_]*:\s*/;

export function stripErrorMarker(message: unknown): string {
  if (typeof message !== 'string') return '';
  return message.replace(MARKER, '').trim();
}
