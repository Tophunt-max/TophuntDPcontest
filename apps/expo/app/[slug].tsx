import { useLocalSearchParams } from 'expo-router';
import BlogDetailScreen from '@/src/screens/BlogDetailScreen';
import ProfileScreen from '@/src/screens/ProfileScreen';

/**
 * Root-level single-segment permalinks. Two things live here.
 *
 * ## `/@username` — the public profile
 *
 * The canonical public profile address. It replaced `/profile?userId=<uid>`, which
 * put the internal Firebase uid — the same identifier used for realtime channel
 * names and Durable Object instances — into every shared link, browser history entry
 * and clipboard. The uid was never a secret and never a capability, but an internal
 * identifier has no business in a url a person is meant to share.
 *
 * Handled HERE rather than in a dedicated `@[username].tsx` route file on purpose.
 * This catch-all already claims every unknown one-segment path, so a separate file
 * would be a second claimant on the same paths and the winner would come down to
 * route-precedence rules; and a literal `@` in a filename has to survive the bundler,
 * the native build and the static web export. Branching on the prefix here needs none
 * of that to be true.
 *
 * The `@` prefix is what makes the two cases separable at all: a blog slug is
 * `[a-z0-9-]`, so it can never begin with `@`, and a username cannot contain one
 * (see `validateUsername` in the Worker). No collision is possible in either
 * direction. `?userId=` still resolves too — links already shared and app builds
 * already installed depend on it — it is just no longer the address anyone is shown.
 *
 * ## `/<slug>` — the original blog permalinks
 *
 * Those posts lived at the site root (not `/blog/<slug>`), e.g.
 *   https://tophunt.in/amazon-cadbury-vday-quiz-answers
 *
 * Static routes (home, splash, auth, blog, contest, legal, setting, …) take
 * precedence, so this only catches slugs no real route claimed.
 *
 * The consequence worth knowing: this route swallows EVERY unknown one-segment path,
 * so `/settings` or any typo arrives here and never reaches `app/+not-found.tsx`.
 * `permalink` tells the screen that, so an unresolved slug renders a real 404 and
 * gets reported, instead of claiming a blog post is missing and reporting nothing.
 */
export default function RootPermalinkScreen() {
  const { slug } = useLocalSearchParams<{ slug?: string }>();
  const value = Array.isArray(slug) ? slug[0] : slug;

  if (typeof value === 'string' && value.startsWith('@')) {
    return <ProfileScreen handle={value.slice(1)} />;
  }
  return <BlogDetailScreen permalink />;
}
