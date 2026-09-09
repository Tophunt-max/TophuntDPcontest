/**
 * The signed-in user's own profile, and the legacy `?userId=<uid>` address.
 *
 * The screen body lives in `src/screens/ProfileScreen.tsx` because TWO routes render
 * it: this one and the public `/@username` permalink claimed by `app/[slug].tsx` —
 * the same split `BlogDetailScreen` already uses for `/blog/<slug>` and the root blog
 * permalink.
 *
 * `?userId=<uid>` still resolves so that links already shared, and app builds already
 * installed, keep working. It is no longer the address a user is shown though: the
 * screen rewrites the url to `/@username` once it knows the handle, so the internal
 * Firebase uid does not sit in the address bar, browser history or clipboard. See
 * `ProfileScreen`.
 */
export { default } from '@/src/screens/ProfileScreen';
